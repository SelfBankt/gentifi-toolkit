import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProtocol } from '../src/mcp/protocol.js';
import { businessTools, searchItems, validateArgs } from '../src/mcp/tools.js';
import { createHttpServer } from '../src/mcp/http.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { businessServer } from '../src/commands/serve.js';
import { MODERN_META, demoItems, demoProject, withTempDir } from './helpers.js';

const BIN = new URL('../bin/gentifi.js', import.meta.url).pathname;

function protocolFor(project = demoProject()) {
  return createProtocol({ serverInfo: { name: 'test/shop', version: '1' }, instructions: 'Test', tools: businessTools(project) });
}

const call = async (protocol, name, args, meta = MODERN_META) => (await protocol.handle({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: meta },
})).response.result;

// --- Tools ---

test('search understands everyday questions and plurals', () => {
  const names = (q) => searchItems(demoItems(), q).map((r) => r.item.sku);
  assert.deepEqual(names('Have they got eggs this week?'), ['EGG-12']);
  assert.deepEqual(names('a loaf of sourdough'), ['BRD-SD']);
  assert.deepEqual(names('veg boxes'), ['VEG-BOX']);
  assert.deepEqual(names('bakery'), ['BRD-SD']);
  assert.deepEqual(names('caviar'), []);
  assert.equal(names('what do you have').length, 3);
});

test('search_catalogue filters by price and stock and reports freshness', async () => {
  const p = protocolFor();
  const cheap = await call(p, 'search_catalogue', { max_price: 5 });
  assert.deepEqual(cheap.structuredContent.items.map((i) => i.sku), ['EGG-12', 'BRD-SD']);
  assert.equal(cheap.structuredContent.pricesAsOf, '2026-10-11T09:00:00.000Z');
  assert.equal(cheap.structuredContent.items[0].priceText, '£3.20 per box');
});

test('check_availability compares stock with the quantity asked for', async () => {
  const p = protocolFor();
  const ok = await call(p, 'check_availability', { sku: 'VEG-BOX', quantity: 2 });
  assert.equal(ok.structuredContent.available, true);
  const short = await call(p, 'check_availability', { sku: 'veg-box', quantity: 20 });
  assert.equal(short.structuredContent.available, false);
  assert.equal(short.structuredContent.note, 'Only 15 in stock.');
  const byName = await call(p, 'check_availability', { sku: 'sourdough loaf' });
  assert.equal(byName.structuredContent.sku, 'BRD-SD');
  const unknown = await call(p, 'check_availability', { sku: 'NOPE' });
  assert.equal(unknown.isError, true);
});

test('prepare_order never orders: totals in pence and a hand-off the customer sends', async () => {
  const p = protocolFor();
  const res = await call(p, 'prepare_order', { items: [{ sku: 'EGG-12', quantity: 3 }, { sku: 'BRD-SD', quantity: 1 }], collection_date: 'Saturday', note: 'Thanks' });
  const s = res.structuredContent;
  assert.equal(s.status, 'not_ordered');
  assert.equal(s.confirmationRequired, true);
  assert.equal(s.total.amount, 14.1); // 3 x 3.20 + 4.50, without floating-point drift
  assert.equal(s.total.formatted, '£14.10');
  assert.equal(s.nextStep.type, 'email');
  const mail = new URL(s.nextStep.url);
  assert.equal(mail.protocol, 'mailto:');
  const body = decodeURIComponent(mail.searchParams.get('body'));
  assert.match(body, /3 x Free-range eggs \(dozen\) \(EGG-12\) £9\.60/);
  assert.match(body, /Collection or date: Saturday/);
  assert.match(body, /Please reply to confirm/);
});

test('prepare_order takes items by name, so no search is needed first', async () => {
  const res = await call(protocolFor(), 'prepare_order', { items: [{ sku: 'sourdough', quantity: 1 }, { sku: 'Free-range eggs (dozen)', quantity: 2 }] });
  const s = res.structuredContent;
  assert.deepEqual(s.lines.map((l) => [l.sku, l.quantity]), [['BRD-SD', 1], ['EGG-12', 2]]);
  assert.equal(s.total.formatted, '£10.90');
});

test('an item name that fits several items is an error listing them, not a guess', async () => {
  const project = demoProject();
  const bread = project.catalogue.items.find((i) => i.sku === 'BRD-SD');
  project.catalogue.items.push({ ...bread, sku: 'BRD-WH', name: 'White loaf' });
  const res = await call(protocolFor(project), 'prepare_order', { items: [{ sku: 'loaf', quantity: 1 }] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /"loaf" could mean Sourdough loaf \(BRD-SD\), White loaf \(BRD-WH\)/);
  const none = await call(protocolFor(), 'prepare_order', { items: [{ sku: 'the', quantity: 1 }] });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /No item matches "the"/);
});

test('prepare_order warns about shortages and hands off to a checkout when there is one', async () => {
  const project = demoProject();
  project.ordering = { method: 'checkout', checkoutUrl: 'https://hollowlane.example/cart/{sku}:{quantity}', bookingUrl: '', notes: '' };
  const res = await call(protocolFor(project), 'prepare_order', { items: [{ sku: 'BRD-SD', quantity: 20 }] });
  const s = res.structuredContent;
  assert.match(s.warnings[0], /only 12 in stock, 20 asked for/);
  assert.deepEqual(s.nextStep, {
    type: 'link',
    label: 'Open the business’s checkout',
    url: 'https://hollowlane.example/cart/BRD-SD:20',
    instructions: 'Show the customer this summary first. Only they can confirm it. They finish and pay on the business’s own checkout page.',
  });
});

test('every tool is labelled read-only, as connector directories require', () => {
  for (const t of businessTools(demoProject())) {
    assert.ok(t.title, t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test('argument validation returns tool errors the agent can correct', async () => {
  assert.deepEqual(validateArgs({ type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false }, { n: 0, x: 1 }), [
    'arguments.n should be at least 1',
    'arguments.x is not a known argument',
  ]);
  const res = await call(protocolFor(), 'prepare_order', { items: [{ sku: 'EGG-12', quantity: 1.5 }] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /quantity should be integer/);
});

// --- Protocol (both eras) ---

test('modern requests: server/discover, resultType, cache hints and server identity', async () => {
  const p = protocolFor();
  const { era, response } = await p.handle({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: MODERN_META } });
  assert.equal(era, 'modern');
  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result.supportedVersions.slice(0, 2), ['2026-07-28', '2025-11-25']);
  assert.deepEqual(response.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'test/shop', version: '1' });
  const list = (await p.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } })).response.result;
  assert.equal(list.cacheScope, 'public');
  assert.ok(list.ttlMs > 0);
  assert.deepEqual(list.tools.map((t) => t.name), ['get_business_info', 'search_catalogue', 'check_availability', 'prepare_order']);
  assert.equal(list.tools[0].handler, undefined);
});

test('modern requests with an unknown version get UnsupportedProtocolVersionError', async () => {
  const { response } = await protocolFor().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } });
  assert.equal(response.error.code, -32022);
  assert.equal(response.error.data.requested, '2099-01-01');
});

test('legacy clients: initialize negotiates, and results carry no modern fields', async () => {
  const p = protocolFor();
  const init = (await p.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } })).response.result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual(init.serverInfo, { name: 'test/shop', version: '1' });
  const future = (await p.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2030-01-01' } })).response.result;
  assert.equal(future.protocolVersion, '2025-11-25');
  const list = (await p.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).response.result;
  assert.equal(list.resultType, undefined);
  assert.equal((await p.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).response.result.constructor, Object);
  assert.equal((await p.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).response, null);
});

test('malformed messages and unknown tools are rejected cleanly', async () => {
  const p = protocolFor();
  assert.equal((await p.handle({ id: 1, method: 'tools/list' })).response.error.code, -32600);
  assert.equal((await p.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).response.error.code, -32601);
  const unknownTool = await p.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buy_everything', arguments: {} } });
  assert.equal(unknownTool.response.error.code, -32602);
});

// --- HTTP transport ---

async function withServer(fn, options = {}) {
  const { protocol, files } = businessServer(demoProject());
  const server = createHttpServer({ protocol, files, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('HTTP: modern requests must mirror version, method and tool name in headers', async () => {
  await withServer(async (base) => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_business_info', arguments: {}, _meta: MODERN_META } };
    const good = await post(`${base}/mcp`, body, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'get_business_info' });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).result.structuredContent.name, 'Hollow Lane Farm Shop');

    const encoded = await post(`${base}/mcp`, body, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': `=?base64?${Buffer.from('get_business_info').toString('base64')}?=` });
    assert.equal(encoded.status, 200);

    const missing = await post(`${base}/mcp`, body, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, -32020);

    const wrongVersion = await post(`${base}/mcp`, body, { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call', 'mcp-name': 'get_business_info' });
    assert.equal(wrongVersion.status, 400);
  });
});

test('HTTP: status codes follow the 2026-07-28 transport rules', async () => {
  await withServer(async (base) => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' };
    const unsupported = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, -32022);

    const unknown = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'prompts/list', params: { _meta: MODERN_META } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'prompts/list' });
    assert.equal(unknown.status, 404);

    assert.equal((await post(`${base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
    assert.equal((await post(`${base}/mcp`, 'not json')).status, 400);
    assert.equal((await post(`${base}/mcp`, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  });
});

test('HTTP: browser origins are checked to block DNS rebinding', async () => {
  await withServer(async (base) => {
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await post(`${base}/mcp`, body, { origin: 'https://evil.example' })).status, 403);
    const local = await post(`${base}/mcp`, body, { origin: 'http://localhost:6274' });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:6274');
    assert.equal((await post(`${base}/mcp`, body, { origin: 'https://shop.example' })).status, 200);
  }, { allowedOrigins: ['https://shop.example'] });
});

test('HTTP: serves the scan-to-add page, discovery files and server card', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await page.text(), /<link rel="ard" href="ard.json">/);
    const ard = await fetch(`${base}/.well-known/ard.json`);
    assert.equal(ard.headers.get('access-control-allow-origin'), '*');
    assert.equal((await ard.json()).entries[0].type, 'application/mcp-server-card+json');
    assert.equal((await (await fetch(`${base}/mcp/server-card`)).json()).name, 'example.hollowlane/hollow-lane-farm-shop');
    assert.equal((await fetch(`${base}/badge.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  });
});

test('client: connects to a modern server, and falls back to initialize for a legacy one', async () => {
  await withServer(async (base) => {
    const client = new McpHttpClient(`${base}/mcp`);
    assert.equal(await client.connect(), 'modern');
    const { tools } = await client.request('tools/list');
    assert.equal(tools.length, 4);
    const res = await client.request('tools/call', { name: 'search_catalogue', arguments: { query: 'eggs' } });
    assert.equal(res.structuredContent.items[0].sku, 'EGG-12');
  });

  // A legacy-only server: rejects server/discover the way a 2025 server would
  const { createServer } = await import('node:http');
  const legacy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.method === 'server/discover') { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('Bad Request: Server not initialized'); }
    if (!('id' in msg)) { res.writeHead(202); return res.end(); }
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'old', version: '1' } } : { tools: [] };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
  });
  await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  try {
    const client = new McpHttpClient(`http://127.0.0.1:${legacy.address().port}/mcp`);
    assert.equal(await client.connect(), 'legacy');
    assert.equal(client.version, '2025-06-18');
    assert.equal(client.sessionId, 'abc');
    assert.deepEqual(await client.request('tools/list'), { tools: [] });
  } finally {
    await new Promise((resolve) => legacy.close(resolve));
  }
});

// --- stdio, through the real CLI ---

test('stdio: "gentifi serve --stdio" answers both eras in order', async () => {
  await withTempDir(async (dir) => {
    const projectFile = join(dir, 'gentifi.json');
    await writeFile(projectFile, JSON.stringify(demoProject()));
    const child = spawn(process.execPath, [BIN, 'serve', '--stdio', '--project', projectFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } },
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_catalogue', arguments: { query: 'veg' } } },
    ];
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    await new Promise((resolve) => child.on('close', resolve));
    const replies = stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, null]);
    assert.equal(replies[0].result.resultType, 'complete');
    assert.equal(replies[1].result.protocolVersion, '2025-11-25');
    assert.equal(replies[2].result.structuredContent.items[0].sku, 'VEG-BOX');
    assert.equal(replies[3].error.code, -32700);
  });
});

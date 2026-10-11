import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProtocol } from '../src/mcp/protocol.js';
import { businessTools } from '../src/mcp/tools.js';
import { createPayments } from '../src/payments/runtime.js';
import { memoryStore } from '../src/payments/store.js';
import { payOrderTool } from '../src/payments/tool.js';
import { decodeInvoice } from '../src/payments/bolt11.js';
import { MCP_PAYMENT_KEY, MCP_PAYMENT_RESPONSE_KEY, isLnbtc, signTransferAuthorization } from '../src/payments/x402.js';
import { generateOutputs } from '../src/lib/outputs.js';
import { checkProject } from '../src/lib/check.js';
import { demoPayments } from '../src/commands/payments.js';
import { main } from '../src/cli.js';
import { capture, demoProject, withTempDir } from './helpers.js';

const BIN = new URL('../bin/gentifi.js', import.meta.url).pathname;
const AGENT = new URL('../examples/agent-pay.mjs', import.meta.url).pathname;

const ELICIT = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
const ACCEPT = { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } };

async function setup(overrides = {}) {
  const project = demoProject({ payments: { ...demoPayments(), ...overrides } });
  const store = memoryStore();
  const payments = await createPayments(project, { store, simulate: true });
  const protocol = createProtocol({ serverInfo: { name: 't', version: '1' }, tools: [...businessTools(project), payOrderTool(project, payments)] });
  let id = 1;
  const call = async (args, extra = {}, meta = ELICIT) => (await protocol.handle({
    jsonrpc: '2.0', id: id++, method: 'tools/call',
    params: { name: 'pay_order', arguments: args, ...extra, _meta: { ...meta, ...extra._meta } },
  })).response.result;
  return { project, store, payments, protocol, call };
}

const EGGS = { items: [{ sku: 'EGG-12', quantity: 2 }], collection_date: 'Saturday' };

test('pay_order asks the customer first, with a clear message and no payment request', async () => {
  const { call } = await setup();
  const first = await call(EGGS);
  assert.equal(first.resultType, 'input_required');
  assert.equal(first.inputRequests.confirm.method, 'elicitation/create');
  assert.equal(first.inputRequests.confirm.params.mode, 'form');
  assert.match(first.inputRequests.confirm.params.message, /^Pay £6\.40 to Hollow Lane Farm Shop for 2 x Free-range eggs \(dozen\)\? Collection: Saturday\./);
  assert.match(first.inputRequests.confirm.params.message, /Test payment: no real money\./);
  assert.equal(first.inputRequests.confirm.params.requestedSchema.properties.confirm.type, 'boolean');
  assert.ok(first.requestState);
  assert.equal(first.structuredContent, undefined);
});

test('declining stops the order; forged or mismatched confirmations ask again', async () => {
  const { call } = await setup();
  const first = await call(EGGS);
  const declined = await call(EGGS, { inputResponses: { confirm: { action: 'decline' } }, requestState: first.requestState });
  assert.equal(declined.structuredContent.status, 'declined');
  const forged = await call(EGGS, { ...ACCEPT, requestState: first.requestState.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
  assert.equal(forged.resultType, 'input_required');
  const otherOrder = await call({ items: [{ sku: 'EGG-12', quantity: 3 }] }, { ...ACCEPT, requestState: first.requestState });
  assert.equal(otherOrder.resultType, 'input_required');
  const unconfirmed = await call(EGGS, { inputResponses: { confirm: { action: 'accept', content: { confirm: false } } }, requestState: first.requestState });
  assert.equal(unconfirmed.resultType, 'input_required');
});

test('a confirmed order gets an x402 payment request bound to it', async () => {
  const { call, payments } = await setup();
  const first = await call(EGGS);
  const challenge = await call(EGGS, { ...ACCEPT, requestState: first.requestState });
  assert.equal(challenge.isError, true);
  const required = challenge.structuredContent;
  assert.equal(required.x402Version, 2);
  assert.equal(JSON.parse(challenge.content[0].text).x402Version, 2);
  assert.match(required.resource.description, /Total £6\.40\. At Hollow Lane Farm Shop\. 8,000 sats or 8\.128 USDC/);
  const [ln, usdc] = required.accepts;
  assert.ok(isLnbtc(ln.network));
  assert.equal(ln.amount, '8000000');
  assert.equal(ln.payTo, payments.lightning.payTo);
  assert.equal(ln.extra.requestBindingProfile, 'mcp:1');
  assert.equal(ln.extra.requestBindingParams.server, 'https://hollowlane.example/mcp');
  const inv = decodeInvoice(ln.extra.invoice);
  assert.equal(inv.descriptionHash, ln.extra.requestHash);
  assert.equal(inv.payee, ln.payTo);
  assert.equal(usdc.network, 'eip155:84532');
  assert.equal(usdc.amount, '8128000');
  assert.equal(usdc.payTo, payments.usdc.payTo);
});

test('paying by Lightning records the order, once', async () => {
  const { call, payments, store } = await setup();
  const first = await call(EGGS);
  const confirmed = { ...ACCEPT, requestState: first.requestState };
  const required = (await call(EGGS, confirmed)).structuredContent;
  const ln = required.accepts.find((a) => isLnbtc(a.network));
  const { preimage } = await payments.lightning.node.pay(ln.extra.invoice);
  const pay = { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, resource: required.resource, accepted: ln, payload: { preimage } } } };
  const done = await call(EGGS, pay);
  assert.equal(done.structuredContent.status, 'paid');
  assert.match(done.content[0].text, /^Paid 8,000 sats by Lightning \(simulated test payment: no money moved\)\. Order ord_/);
  assert.equal(done._meta[MCP_PAYMENT_RESPONSE_KEY].success, true);
  assert.equal(store.orders.length, 1);
  assert.equal(store.orders[0].payment.rail, 'lightning');
  assert.equal(store.orders[0].collectionDate, 'Saturday');
  const again = await call(EGGS, pay);
  assert.equal(again.isError, true);
  assert.match(again.structuredContent.error, /duplicate_settlement/);
  assert.equal(store.orders.length, 1);

  // The same proof can't buy a different order: the invoice is bound to the original call
  const firstOther = await call({ items: [{ sku: 'EGG-12', quantity: 1 }] });
  const other = await call({ items: [{ sku: 'EGG-12', quantity: 1 }] }, { ...ACCEPT, requestState: firstOther.requestState, _meta: pay._meta });
  assert.equal(other.isError, true);
  assert.match(other.structuredContent.error, /invalid_exact_lnbtc/);
});

test('paying with USDC goes through the facilitator; the payer can’t change the terms', async () => {
  const { call, store } = await setup();
  const first = await call(EGGS);
  const confirmed = { ...ACCEPT, requestState: first.requestState };
  const required = (await call(EGGS, confirmed)).structuredContent;
  const usdc = required.accepts.find((a) => a.network === 'eip155:84532');
  const now = Math.floor(Date.now() / 1000);
  const cheap = { ...usdc, amount: '1' };
  const lowball = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: cheap, payload: signTransferAuthorization({ privateKey: 5n, requirement: cheap, now }) } } });
  assert.match(lowball.structuredContent.error, /terms have changed/);
  const done = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: usdc, payload: signTransferAuthorization({ privateKey: 5n, requirement: usdc, now }) } } });
  assert.equal(done.structuredContent.status, 'paid');
  assert.equal(store.orders[0].payment.rail, 'usdc');
  assert.match(store.orders[0].payment.transaction, /^0x[0-9a-f]{64}$/);
});

test('pay_order refuses what it can’t do safely', async () => {
  const { call } = await setup();
  const legacyMeta = {};
  assert.match((await call(EGGS, {}, legacyMeta)).content[0].text, /needs an app that supports MCP 2026-07-28/);
  assert.match((await call(EGGS, {}, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} })).content[0].text, /ask the customer to confirm/);
  assert.match((await call({ items: [{ sku: 'BRD-SD', quantity: 50 }] })).content[0].text, /Not enough stock/);
});

test('the business publishes its payees, so agents can check who they pay', async () => {
  const { project, payments } = await setup();
  const files = generateOutputs(project, '0.1.0', { payees: payments.payees });
  const [entry] = JSON.parse(files.get('ard.json')).entries;
  assert.ok(entry.capabilities.includes('pay_order'));
  assert.deepEqual(entry.metadata.payments.map((p) => p.rail), ['lightning', 'usdc']);
  assert.equal(JSON.parse(files.get('business.jsonld')).paymentAccepted, 'Lightning (bitcoin), USDC');
});

test('the Gentified test runs the payment flow against simulated rails', async () => {
  const project = demoProject({ payments: demoPayments() });
  const results = await checkProject(project, { toolkitVersion: '0.1.0', now: new Date('2026-10-12T09:00:00Z') });
  const pay = results.filter((r) => r.group === 'Payments (prototype)');
  assert.deepEqual(pay.filter((r) => r.level === 'fail'), []);
  assert.equal(pay.filter((r) => r.level === 'pass').length, 8);
  const broken = demoProject({ payments: { lightning: { network: 'mainnet', node: 'simulated' } } });
  const bad = await checkProject(broken, { toolkitVersion: '0.1.0' });
  assert.match(bad.filter((r) => r.level === 'fail').map((r) => r.text).join('\n'), /payments\.rates\.BTC/);
});

test('end to end over HTTP: the demo agent confirms, checks and pays', async () => {
  await withTempDir(async (dir) => {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const projectFile = join(dir, 'gentifi.json');
    const project = demoProject({ payments: demoPayments() });
    project.publish.baseUrl = `http://localhost:${port}`;
    await writeFile(projectFile, JSON.stringify(project));
    const server = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--project', projectFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        server.stdout.on('data', (d) => { if (String(d).includes('Press Ctrl+C')) resolve(); });
        server.on('exit', () => reject(new Error('server exited')));
      });
      const run = (input, extra) => new Promise((resolve) => {
        const agent = spawn(process.execPath, [AGENT, '--mcp', `http://localhost:${port}/mcp`, '--item', 'VEG-BOX:1', ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        agent.stdout.on('data', (d) => { out += d; });
        agent.stderr.on('data', (d) => { out += d; });
        agent.on('close', (code) => resolve({ code, out }));
        agent.stdin.end(input);
      });
      const paid = await run('y\n', ['--rail', 'lightning']);
      assert.equal(paid.code, 0, paid.out);
      assert.match(paid.out, /✓ the invoice is bound to exactly this order/);
      assert.match(paid.out, /✓ Paid 22,500 sats by Lightning/);
      const declined = await run('n\n', []);
      assert.match(declined.out, /The customer declined\. Nothing was ordered or paid\./);
      const orders = (await readFile(join(dir, '.gentifi', 'orders.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(orders.length, 1);
      assert.equal(orders[0].total.formatted, '£18.00');
      assert.match(await readFile(join(dir, '.gentifi', '.gitignore'), 'utf8'), /^\*$/m);
    } finally {
      server.kill();
    }
  });
});

test('gentifi payments --demo sets up simulated rails; plain gentifi payments explains them', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'gentifi.json');
    await writeFile(file, JSON.stringify(demoProject()));
    let io = capture();
    assert.equal(await main(['payments', '--project', file], io), 0);
    assert.match(io.stdout, /No payments set up/);
    io = capture();
    assert.equal(await main(['payments', '--demo', '--project', file], io), 0);
    assert.match(io.stdout, /No real money moves/);
    io = capture();
    assert.equal(await main(['payments', '--demo', '--project', file], io), 1);
    io = capture();
    assert.equal(await main(['payments', '--project', file], io), 0);
    assert.match(io.stdout, /£10\.00 is 12,500 sats/);
    assert.match(io.stdout, /£10\.00 is 12\.70 USDC/);
  });
});

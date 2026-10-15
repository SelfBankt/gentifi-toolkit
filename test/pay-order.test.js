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
import { MCP_PAYMENT_KEY, MCP_PAYMENT_RESPONSE_KEY, X402_EXACT_PERMIT2_PROXY, isLnbtc, signPermit2Authorization, signTransferAuthorization } from '../src/payments/x402.js';
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

// Changes a character mid-string: the last base64 character can carry only padding bits, so changing it may change nothing
const flip = (s) => { const i = Math.floor(s.length / 2); return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1); };

test('declining stops the order; forged or mismatched confirmations ask again', async () => {
  const { call } = await setup();
  const first = await call(EGGS);
  const declined = await call(EGGS, { inputResponses: { confirm: { action: 'decline' } }, requestState: first.requestState });
  assert.equal(declined.structuredContent.status, 'declined');
  const forged = await call(EGGS, { ...ACCEPT, requestState: flip(first.requestState) });
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
  assert.match(required.resource.description, /Total £6\.40\. At Hollow Lane Farm Shop\. 8,000 sats, 8\.128 USDC or 8\.128 USDT at today's rates\./);
  const [ln, usdc, usdt] = required.accepts;
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
  assert.deepEqual(usdc.extra, { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' });
  // USDT has no EIP-3009, so it is offered through Permit2
  assert.equal(usdt.network, 'eip155:84532');
  assert.equal(usdt.asset, payments.usdt.token.asset);
  assert.equal(usdt.amount, '8128000');
  assert.equal(usdt.payTo, payments.usdt.payTo);
  assert.deepEqual(usdt.extra, { assetTransferMethod: 'permit2' });
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

test('paying with USDT goes through Permit2, straight to the business', async () => {
  const { call, store, payments } = await setup();
  const first = await call(EGGS);
  const confirmed = { ...ACCEPT, requestState: first.requestState };
  const required = (await call(EGGS, confirmed)).structuredContent;
  const usdt = required.accepts.find((a) => a.asset === payments.usdt.token.asset);
  const now = Math.floor(Date.now() / 1000);
  const pay = (payload, accepted = usdt) => call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, resource: required.resource, accepted, payload } } });

  // Signed for someone else, or tampered with after signing: refused, and nothing is taken
  const elsewhere = signPermit2Authorization({ privateKey: 5n, requirement: { ...usdt, payTo: '0x000000000000000000000000000000000000bEEF' }, now });
  assert.match((await pay(elsewhere)).structuredContent.error, /invalid_permit2_recipient_mismatch/);
  const tampered = signPermit2Authorization({ privateKey: 5n, requirement: usdt, now });
  tampered.permit2Authorization.permitted.amount = '1';
  assert.match((await pay(tampered)).structuredContent.error, /invalid_permit2_signature/);
  assert.equal(store.orders.length, 0);

  const payload = signPermit2Authorization({ privateKey: 5n, requirement: usdt, now });
  assert.equal(payload.permit2Authorization.spender, X402_EXACT_PERMIT2_PROXY);
  const done = await pay(payload);
  assert.equal(done.structuredContent.status, 'paid');
  assert.match(done.content[0].text, /^Paid 8\.128 USDT \(simulated test payment: no money moved\)\. Order ord_/);
  assert.equal(store.orders[0].payment.rail, 'usdt');
  assert.equal(store.orders[0].payment.symbol, 'USDT');
  assert.equal(store.orders[0].payment.payer, '0xe1AB8145F7E55DC933d51a18c793F901A3A0b276');

  const again = await pay(payload);
  assert.match(again.content[0].text, /already been paid, so nothing more was taken/);
  assert.equal(store.orders.length, 1);
});

test('one confirmation pays for one order, whichever rail is used', async () => {
  // Lightning first: a second payment by USDC is refused before anything settles
  let { call, payments, store } = await setup();
  let first = await call(EGGS);
  let confirmed = { ...ACCEPT, requestState: first.requestState };
  let required = (await call(EGGS, confirmed)).structuredContent;
  assert.equal((await call(EGGS, confirmed)).resultType, 'input_required', 'a second payment request needs the customer again');
  const ln = required.accepts.find((a) => isLnbtc(a.network));
  const { preimage } = await payments.lightning.node.pay(ln.extra.invoice);
  const paidLn = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: ln, payload: { preimage } } } });
  assert.equal(paidLn.structuredContent.status, 'paid');
  const usdc = required.accepts.find((a) => a.network === 'eip155:84532' && a.extra.assetTransferMethod === 'eip3009');
  const now = Math.floor(Date.now() / 1000);
  const secondCoin = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: usdc, payload: signTransferAuthorization({ privateKey: 5n, requirement: usdc, now }) } } });
  assert.match(secondCoin.content[0].text, /already been paid, so nothing more was taken/);
  assert.equal(store.orders.length, 1);

  // A stablecoin first: Lightning money has already moved, so it is recorded for a refund
  ({ call, payments, store } = await setup());
  first = await call(EGGS);
  confirmed = { ...ACCEPT, requestState: first.requestState };
  required = (await call(EGGS, confirmed)).structuredContent;
  const usdt = required.accepts.find((a) => a.extra.assetTransferMethod === 'permit2');
  const paidUsdt = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: usdt, payload: signPermit2Authorization({ privateKey: 5n, requirement: usdt, now }) } } });
  assert.equal(paidUsdt.structuredContent.status, 'paid');
  const ln2 = required.accepts.find((a) => isLnbtc(a.network));
  const { preimage: p2 } = await payments.lightning.node.pay(ln2.extra.invoice);
  const late = await call(EGGS, { ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, accepted: ln2, payload: { preimage: p2 } } } });
  assert.equal(late.isError, true);
  assert.match(late.content[0].text, /still reached Hollow Lane Farm Shop, which should refund it/);
  assert.deepEqual(store.orders.map((o) => [o.payment.rail, o.status]), [['usdt', 'paid'], ['lightning', 'duplicate_payment']]);
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
  assert.deepEqual(entry.metadata.payments.map((p) => p.rail), ['lightning', 'usdc', 'usdt']);
  assert.deepEqual(entry.metadata.payments[2], { rail: 'usdt', network: 'eip155:84532', asset: payments.usdt.token.asset, symbol: 'USDT', decimals: 6, payTo: payments.usdt.payTo });
  assert.equal(JSON.parse(files.get('business.jsonld')).paymentAccepted, 'Lightning (bitcoin), USDC, USDT');
  assert.match(files.get('SKILL.md'), /takes payment by Lightning, USDC or USDT/);
});

test('the Gentified test runs the payment flow against simulated rails', async () => {
  const project = demoProject({ payments: demoPayments() });
  const results = await checkProject(project, { toolkitVersion: '0.1.0', now: new Date('2026-10-12T09:00:00Z') });
  const pay = results.filter((r) => r.group === 'Payments (prototype)');
  assert.deepEqual(pay.filter((r) => r.level === 'fail'), []);
  assert.equal(pay.filter((r) => r.level === 'pass').length, 12);
  assert.ok(pay.some((r) => /A USDT payment through Permit2 is checked and recorded/.test(r.text)));
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
      let banner = '';
      await new Promise((resolve, reject) => {
        server.stdout.on('data', (d) => {
          banner += d;
          if (banner.includes('Press Ctrl+C')) resolve();
        });
        server.on('exit', () => reject(new Error('server exited')));
      });
      const run = (input, extra, env = {}) => new Promise((resolve) => {
        const agent = spawn(process.execPath, [AGENT, '--mcp', `http://localhost:${port}/mcp`, '--item', 'VEG-BOX:1', ...extra], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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
      const usdt = await run('y\n', ['--rail', 'usdt']);
      assert.equal(usdt.code, 0, usdt.out);
      assert.match(usdt.out, /Signing a Permit2 payment of 22\.86 USDT to 0x/);
      assert.match(usdt.out, /✓ Paid 22\.86 USDT \(simulated test payment: no money moved\)/);
      const nwcUri = /GENTIFI_PAYER_NWC='([^']+)'/.exec(banner)?.[1];
      assert.ok(nwcUri, 'serve prints a simulated NWC wallet');
      const viaNwc = await run('y\n', ['--rail', 'lightning', '--nwc'], { GENTIFI_PAYER_NWC: nwcUri });
      assert.equal(viaNwc.code, 0, viaNwc.out);
      assert.match(viaNwc.out, /asking your wallet over Nostr Wallet Connect/);
      assert.match(viaNwc.out, /✓ Paid 22,500 sats by Lightning/);
      const declined = await run('n\n', []);
      assert.match(declined.out, /The customer declined\. Nothing was ordered or paid\./);
      const orders = (await readFile(join(dir, '.gentifi', 'orders.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(orders.map((o) => [o.payment.rail, o.total.formatted]), [['lightning', '£18.00'], ['usdt', '£18.00'], ['lightning', '£18.00']]);
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
    assert.match(io.stdout, /£10\.00 is 12\.70 USDT/);
  });
});

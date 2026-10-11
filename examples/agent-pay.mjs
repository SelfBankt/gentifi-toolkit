#!/usr/bin/env node
// A demo of the customer's side of pay_order: the agent app, the agent and the wallet.
//
//   gentifi payments --demo && gentifi serve          (in the business's project folder)
//   node examples/agent-pay.mjs --item EGG-12:2 --collect Saturday
//
// It asks you to confirm in this terminal, exactly as an agent app would, then
// checks the payment request before paying: the invoice must be bound to this
// order and pay the business's published key or address, and nobody else.
//
// Payers:
//   Lightning, simulated (default when the server runs a simulated node): no money moves.
//   Lightning, your own LND node: --lnd-url https://127.0.0.1:8080 [--lnd-cert tls.cert]
//     with GENTIFI_PAYER_MACAROON set to a macaroon allowed to send payments (hex).
//   USDC or USDT (--rail usdc | usdt): GENTIFI_PAYER_KEY set to a test wallet's private
//     key (hex). Without it, a throwaway key is used, which only a simulated facilitator
//     accepts. USDT is paid with Permit2, which a real wallet approves once per token.
//   USDT on Lightning: a wallet holding USDT through Taproot Assets pays the Lightning
//     invoice like any other; its edge node converts, and the business receives bitcoin.

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { McpHttpClient } from '../src/mcp/client.js';
import { decodeInvoice } from '../src/payments/bolt11.js';
import { lndNode, randomPrivateKey } from '../src/payments/lightning.js';
import { formatSats, formatToken } from '../src/payments/quote.js';
import { MCP_PAYMENT_KEY, MCP_PAYMENT_RESPONSE_KEY, isLnbtc, mcpRequestHash, signEvmPayment, transferMethodOf } from '../src/payments/x402.js';

const { values } = parseArgs({
  options: {
    mcp: { type: 'string', default: 'http://localhost:8787/mcp' },
    item: { type: 'string', multiple: true, default: ['EGG-12:2'] },
    collect: { type: 'string' },
    rail: { type: 'string' },
    'lnd-url': { type: 'string' },
    'lnd-cert': { type: 'string' },
  },
});

const say = (s = '') => process.stdout.write(`${s}\n`);
const stop = (s) => { say(`\n✗ ${s}`); process.exit(1); };
const sha256 = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

const mcpUrl = values.mcp;
const base = mcpUrl.replace(/\/mcp\/?$/, '');
const args = {
  items: values.item.map((i) => {
    const [sku, qty = '1'] = i.split(':');
    return { sku, quantity: Number(qty) };
  }),
  ...(values.collect ? { collection_date: values.collect } : {}),
};

// 1. What the business publishes: who payments should go to
const manifest = await fetch(`${base}/ard.json`).then((r) => r.json()).catch(() => stop(`Couldn't read ${base}/ard.json`));
const entry = manifest.entries?.find((e) => e.type === 'application/mcp-server-card+json');
const payees = entry?.metadata?.payments ?? [];
say(`Business: ${entry?.displayName ?? 'unknown'}`);
if (!payees.length) stop('This business publishes no payees, so its payment requests can’t be checked. Not paying.');
for (const p of payees) say(`  publishes ${p.rail} payee ${p.payTo} on ${p.network}`);

// 2. Ask the business's connector to take payment, as an app that can show confirmations
const client = new McpHttpClient(mcpUrl, { capabilities: { elicitation: { form: {} } }, timeoutMs: 60000 });
if ((await client.connect()) !== 'modern') stop('This connector speaks an older MCP version without in-app confirmations.');
const call = (extra = {}) => client.request('tools/call', { name: 'pay_order', arguments: args, ...extra });

let result = await call();
if (result.resultType !== 'input_required') stop(`Expected a confirmation request, got: ${JSON.stringify(result).slice(0, 200)}`);
const ask = result.inputRequests.confirm.params;
say(`\n┌ Your agent app asks you\n│ ${ask.message}\n└`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const yes = /^y(es)?$/i.test((await rl.question('Confirm? (y/N) ')).trim());
rl.close();
const answered = (action) => ({
  inputResponses: { confirm: action === 'accept' ? { action, content: { confirm: true } } : { action } },
  requestState: result.requestState,
});
if (!yes) {
  const declined = await call(answered('decline'));
  say(`\n${declined.content?.[0]?.text ?? 'Declined.'}`);
  process.exit(0);
}
const confirmed = answered('accept');

// 3. The payment request
const challenge = await call(confirmed);
const required = challenge.structuredContent;
if (!challenge.isError || required?.x402Version !== 2) stop(`Expected a payment request, got: ${challenge.content?.[0]?.text}`);
say(`\nPayment request: ${required.resource.description}`);
// Each option is matched to a published payee by network and asset
const payeeFor = (r) => payees.find((p) => p.network === r.network && p.asset.toLowerCase() === String(r.asset).toLowerCase());
const requirement = required.accepts.find((r) => !values.rail || payeeFor(r)?.rail === values.rail);
if (!requirement) stop(`No ${values.rail} option offered.`);

// 4. Check it before paying: right payee, right order, right amount
const payee = payeeFor(requirement);
if (!payee || payee.payTo.toLowerCase() !== requirement.payTo.toLowerCase()) stop('The request pays someone other than the business’s published payee. Not paying.');
let payload;
if (isLnbtc(requirement.network)) {
  const inv = decodeInvoice(requirement.extra.invoice);
  const expected = mcpRequestHash({ server: mcpUrl, name: 'pay_order', args });
  const checks = [
    [requirement.extra.requestBindingParams?.server === mcpUrl, 'the invoice names this connector'],
    [inv.descriptionHash === expected && requirement.extra.requestHash === expected, 'the invoice is bound to exactly this order'],
    [inv.payee === requirement.payTo, 'the invoice is signed by the published key'],
    [inv.amountMsat === BigInt(requirement.amount), 'the invoice amount matches'],
    [inv.expiry === requirement.maxTimeoutSeconds && Date.now() / 1000 < inv.timestamp + inv.expiry, 'the invoice is current'],
  ];
  for (const [ok, what] of checks) {
    if (!ok) stop(`Check failed: ${what}. Not paying.`);
    say(`  ✓ ${what}`);
  }
  say(`\nPaying ${formatSats(requirement.amount)} by Lightning…`);
  let paid;
  if (values['lnd-url']) {
    const node = await lndNode({ url: values['lnd-url'], macaroon: process.env.GENTIFI_PAYER_MACAROON, tlsCert: values['lnd-cert'], network: 'testnet' });
    paid = await node.pay(requirement.extra.invoice);
  } else {
    const res = await fetch(`${base}/dev/simulated-lightning/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoice: requirement.extra.invoice }) });
    paid = await res.json();
    if (!res.ok) stop(`The simulated network refused: ${paid.error}. Is the server running a simulated node? Use --lnd-url to pay from a real node.`);
    say('  (simulated Lightning network: no money moved)');
  }
  if (sha256(paid.preimage) !== inv.paymentHash) stop('The payment proof does not match the invoice.');
  payload = { preimage: paid.preimage };
} else {
  say(`  ✓ it pays the address the business publishes for ${payee.symbol}`);
  const key = process.env.GENTIFI_PAYER_KEY ? Buffer.from(process.env.GENTIFI_PAYER_KEY.replace(/^0x/, ''), 'hex') : randomPrivateKey();
  if (!process.env.GENTIFI_PAYER_KEY) say('  (no GENTIFI_PAYER_KEY: using a throwaway key, which only a simulated facilitator accepts)');
  const permit2 = transferMethodOf(requirement) === 'permit2';
  say(`\nSigning ${permit2 ? 'a Permit2 payment' : 'a payment'} of ${formatToken(requirement.amount, payee.symbol, payee.decimals)} to ${requirement.payTo}…`);
  if (permit2) say('  (on a real network, the wallet approves Permit2 for this token once, before its first payment)');
  payload = signEvmPayment({ privateKey: key, requirement, now: Math.floor(Date.now() / 1000) });
}

// 5. Send the proof; the business records the order
const receipt = await call({ ...confirmed, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, resource: required.resource, accepted: requirement, payload } } });
if (receipt.isError) stop(receipt.structuredContent?.error ?? receipt.content?.[0]?.text);
say(`\n✓ ${receipt.content[0].text}`);
const settlement = receipt._meta?.[MCP_PAYMENT_RESPONSE_KEY];
if (settlement) say(`  settlement: ${settlement.network} ${settlement.transaction}`);

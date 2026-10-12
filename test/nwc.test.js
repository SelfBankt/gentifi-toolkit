import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorrSign, schnorrVerify, xOnlyPublicKey } from '../src/payments/secp256k1.js';
import {
  decryptFrom, encryptFor, eventId, finalizeEvent, getPublicKey, nip04Decrypt, nip04Encrypt,
  nip44ConversationKey, nip44Decrypt, nip44Encrypt, nip44PaddedLength, verifyEvent,
} from '../src/payments/nostr.js';
import { startRelay } from '../src/payments/relay.js';
import { NwcError, nwcClient, parseNwcUri, simulatedNwcWallet } from '../src/payments/nwc.js';
import { nwcNode, simulatedNode } from '../src/payments/lightning.js';
import { createPayments, paymentProblems } from '../src/payments/runtime.js';
import { memoryStore } from '../src/payments/store.js';
import { checkChallengeInvoice } from '../src/payments/x402.js';
import { decodeInvoice } from '../src/payments/bolt11.js';
import { demoProject } from './helpers.js';

const hex = (b) => Buffer.from(b).toString('hex');
const SK_A = '0000000000000000000000000000000000000000000000000000000000000003';
const SK_B = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364139';

test('BIP-340: test vector 0, and signatures that fail when anything changes', () => {
  const zero = Buffer.alloc(32);
  assert.equal(hex(xOnlyPublicKey(3n)), 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const sig = schnorrSign(zero, 3n, zero);
  assert.equal(hex(sig), 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0');
  assert.equal(schnorrVerify(sig, zero, xOnlyPublicKey(3n)), true);
  assert.equal(schnorrVerify(sig, Buffer.alloc(32, 1), xOnlyPublicKey(3n)), false);
  assert.equal(schnorrVerify(sig, zero, xOnlyPublicKey(4n)), false);
  const random = schnorrSign(Buffer.alloc(32, 7), 12345n);
  assert.equal(schnorrVerify(random, Buffer.alloc(32, 7), xOnlyPublicKey(12345n)), true);
});

// Checked with nostr-tools 2.10.4: it verifies this event, and produces the same NIP-44 payload
const EVENT = {
  id: 'd7ed2fdf7d604e05e5e233782c56f6aa9246b65e2e9c7f453420fe85de981832',
  pubkey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
  created_at: 1760000000,
  kind: 23194,
  tags: [['p', '2f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01']],
  content: 'hello "quoted"\nline é',
  sig: '9503160e0bb4fee6c75c372df065758791e8696265fad87253b979dac27f4decfc98d0c0f105034821fc667169c805350ee8a991c620b8e0e07a02b499dc1686',
};

test('Nostr events: ids, signatures and tampering', () => {
  assert.equal(getPublicKey(SK_B), '2f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01');
  assert.equal(eventId(EVENT), EVENT.id);
  assert.equal(verifyEvent(EVENT), true);
  assert.equal(verifyEvent({ ...EVENT, content: 'changed' }), false);
  const signed = finalizeEvent({ kind: 1, created_at: 1760000000, tags: [], content: 'hi' }, SK_A);
  assert.equal(verifyEvent(signed), true);
});

test('NIP-44 v2: the cross-checked vector, padding, and tampering', () => {
  const ck = nip44ConversationKey(SK_A, getPublicKey(SK_B));
  assert.equal(hex(ck), 'fe8fe41f09582cb074a32ecdb398f4c47067d39e4eba3422824bb99d31cb5dc8');
  assert.equal(hex(nip44ConversationKey(SK_B, getPublicKey(SK_A))), hex(ck));
  const payload = 'AgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBNJAlQ7/M2hewEzogUXqKl1WifgI9a3FU64Y2ACBFla6PdXjQ/pqW7p7cFu8dEk9Huk/7O/OhCRyKTGCGs0pJfl2d';
  assert.equal(nip44Encrypt(ck, 'a', Buffer.alloc(32, 1)), payload);
  assert.equal(nip44Decrypt(ck, payload), 'a');
  const bytes = Buffer.from(payload, 'base64');
  bytes[40] ^= 1;
  assert.throws(() => nip44Decrypt(ck, bytes.toString('base64')), /authentication/);
  for (const [len, padded] of [[1, 32], [33, 64], [65, 96], [200, 224], [320, 320], [400, 448], [515, 640], [1020, 1024], [65535, 65536]]) {
    assert.equal(nip44PaddedLength(len), padded);
  }
  const long = `${'x'.repeat(300)} £ é`;
  assert.equal(nip44Decrypt(ck, nip44Encrypt(ck, long)), long);
});

test('NIP-04 still works for older wallets, and the right scheme is picked by shape', () => {
  const pkA = getPublicKey(SK_A);
  const pkB = getPublicKey(SK_B);
  assert.equal(nip04Decrypt(SK_B, pkA, nip04Encrypt(SK_A, pkB, 'pay me')), 'pay me');
  assert.equal(decryptFrom(SK_B, pkA, encryptFor('nip04', SK_A, pkB, 'old')), 'old');
  assert.equal(decryptFrom(SK_B, pkA, encryptFor('nip44_v2', SK_A, pkB, 'new')), 'new');
});

test('NWC connection strings are checked', () => {
  const pk = getPublicKey(SK_B);
  const parsed = parseNwcUri(`nostr+walletconnect://${pk}?relay=wss%3A%2F%2Frelay.example&secret=${SK_A}&lud16=shop%40example.com`);
  assert.deepEqual(parsed, { walletPubkey: pk, secret: SK_A, relays: ['wss://relay.example'], lud16: 'shop@example.com' });
  assert.throws(() => parseNwcUri('https://example.com'), /nostr\+walletconnect/);
  assert.throws(() => parseNwcUri(`nostr+walletconnect://${pk}?relay=wss://r.example`), /secret/);
  assert.throws(() => parseNwcUri(`nostr+walletconnect://${pk}?secret=${SK_A}`), /relay/);
});

test('NWC end to end over a relay: pay, budgets, older wallets and a business invoice', async () => {
  const relay = await startRelay();
  const shop = simulatedNode({ network: 'testnet' });
  try {
    // A customer's wallet pays the shop's invoice, within its budget
    const wallet = await simulatedNwcWallet({ relayUrl: relay.url, pay: (i) => shop.pay(i), budgetMsat: 20000000n });
    const client = nwcClient(wallet.uri, { timeoutMs: 5000 });
    assert.deepEqual((await client.getInfo()).methods, ['get_info', 'pay_invoice']);
    const first = await shop.createInvoice({ amountMsat: 13625000n, descriptionHash: 'ab'.repeat(32), expiry: 600 });
    const paid = await client.payInvoice(first.invoice);
    assert.equal(createHash('sha256').update(Buffer.from(paid.preimage, 'hex')).digest('hex'), first.paymentHash);
    assert.equal(wallet.spentMsat, 13625000n);
    const second = await shop.createInvoice({ amountMsat: 13625000n, descriptionHash: 'cd'.repeat(32), expiry: 600 });
    await assert.rejects(client.payInvoice(second.invoice), (e) => e instanceof NwcError && e.code === 'QUOTA_EXCEEDED');
    await assert.rejects(client.makeInvoice({ amountMsat: 1000n }), (e) => e.code === 'NOT_IMPLEMENTED');

    // A stranger with a made-up secret gets no answer
    const stranger = nwcClient(wallet.uri.replace(/secret=[0-9a-f]+/, `secret=${SK_A}`), { timeoutMs: 300 });
    await assert.rejects(stranger.payInvoice(second.invoice), (e) => e.code === 'TIMEOUT');
    wallet.close();

    // A wallet that only speaks NIP-04
    const old = await simulatedNwcWallet({ relayUrl: relay.url, pay: (i) => shop.pay(i), encryption: ['nip04'] });
    const small = await shop.createInvoice({ amountMsat: 1000n, descriptionHash: 'ef'.repeat(32), expiry: 600 });
    assert.ok((await nwcClient(old.uri, { timeoutMs: 5000 }).payInvoice(small.invoice)).preimage);
    old.close();

    // A business wallet makes request-bound invoices that pass the x402 checks
    const businessWallet = await simulatedNwcWallet({ relayUrl: relay.url, makeInvoice: (p) => shop.createInvoice(p) });
    const node = nwcNode({ uri: businessWallet.uri, network: 'testnet', payTo: shop.payTo });
    const requestHash = '12'.repeat(32);
    const made = await node.createInvoice({ amountMsat: 8000000n, descriptionHash: requestHash, expiry: 600 });
    const inv = checkChallengeInvoice(made.invoice, { network: shop.network, amountMsat: 8000000n, payTo: shop.payTo, requestHash, maxTimeoutSeconds: 600, now: Math.floor(Date.now() / 1000) });
    assert.equal(inv.paymentHash, made.paymentHash);
    assert.equal(decodeInvoice(made.invoice).descriptionHash, requestHash);
    businessWallet.close();
  } finally {
    await relay.close();
  }
});

test('payments config accepts an NWC wallet for the business, with its secret in the environment', async () => {
  const lightning = { network: 'testnet', node: { type: 'nwc', uriEnv: 'SHOP_NWC' }, payTo: `02${'11'.repeat(32)}` };
  assert.deepEqual(paymentProblems({ rates: { BTC: '80000' }, lightning }), []);
  assert.match(paymentProblems({ rates: { BTC: '80000' }, lightning: { ...lightning, node: { type: 'nwc' } } }).join(), /uriEnv/);
  const project = demoProject({ payments: { rates: { BTC: '80000' }, lightning } });
  await assert.rejects(createPayments(project, { store: memoryStore(), env: {} }), /Set SHOP_NWC/);
  const uri = `nostr+walletconnect://${getPublicKey(SK_B)}?relay=ws%3A%2F%2F127.0.0.1%3A9&secret=${SK_A}`;
  const payments = await createPayments(project, { store: memoryStore(), env: { SHOP_NWC: uri, GENTIFI_STATE_SECRET: '00'.repeat(32) } });
  assert.equal(payments.lightning.node.kind, 'nwc');
  assert.equal(payments.payees[0].payTo, lightning.payTo);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicKey, publicKeyPoint, sign, recover, compress, N } from '../src/payments/secp256k1.js';
import { keccak256 } from '../src/payments/keccak.js';
import { DEFAULT_FEATURES, decodeInvoice, encodeInvoice } from '../src/payments/bolt11.js';
import { jcs } from '../src/payments/jcs.js';
import { formatSats, formatUsdc, penceToMsat, penceToUsdcUnits } from '../src/payments/quote.js';
import { memoryStore, openState, sealState } from '../src/payments/store.js';
import { simulatedNode } from '../src/payments/lightning.js';
import {
  LNBTC, TRANSFER_TYPEHASH, addressFromPrivateKey, checkChallengeInvoice, lnbtcRequirement, mcpRequestHash,
  recoverTransferSigner, settleLnbtc, signTransferAuthorization, simulatedEvmFacilitator, usdcRequirement,
} from '../src/payments/x402.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');

// From lightning/bolts 11-payment-encoding.md, "Examples"
const BOLT11_KEY = Buffer.from('e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734', 'hex');
const DONATION = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const HASHED = 'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44';
const PICO = 'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz';
// From x402 specs/schemes/exact/scheme_exact_lnbtc.md, signed with private key 1
const LNBTC_VECTOR = 'lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f';

// --- Primitives ---

test('secp256k1: public keys, and signatures that recover to the signer', () => {
  assert.equal(hex(publicKey(1n)), '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(hex(publicKey(BOLT11_KEY)), '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
  const h = createHash('sha256').update('pay').digest();
  const { r, s, recid } = sign(h, 12345n);
  assert.ok(s <= N / 2n, 'low S');
  assert.equal(hex(compress(recover(h, r, s, recid))), hex(publicKey(12345n)));
  assert.equal(recover(h, 0n, s, recid), null);
});

test('keccak-256 and EVM addresses', () => {
  assert.equal(hex(keccak256('')), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(hex(keccak256('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(hex(keccak256(Buffer.alloc(200, 0xab))).length, 64); // more than one block
  assert.equal(hex(TRANSFER_TYPEHASH), '7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267');
  assert.equal(addressFromPrivateKey(1n), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.ok(publicKeyPoint(2n));
});

test('JCS sorts members and rejects what JSON can’t hold', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'é'], c: { z: 0.5, y: -0 } }), '{"a":[true,null,"é"],"b":1,"c":{"y":0,"z":0.5}}');
  assert.throws(() => jcs({ a: Infinity }), /non-finite/);
  assert.throws(() => jcs('\ud800'), /invalid Unicode/);
});

// --- BOLT 11 ---

test('BOLT 11: the specification examples decode to their documented values', () => {
  const d = decodeInvoice(DONATION);
  assert.equal(d.payee, '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
  assert.equal(d.timestamp, 1496314658);
  assert.equal(d.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(d.paymentSecret, '11'.repeat(32));
  assert.equal(d.description, 'Please consider supporting this project');
  assert.equal(d.amountMsat, null);
  const h = decodeInvoice(HASHED);
  assert.equal(h.amountMsat, 2000000000n);
  assert.equal(h.descriptionHash, '3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1');
  const p = decodeInvoice(PICO);
  assert.equal(p.amountMsat, 967878534n);
  assert.equal(p.expiry, 604800);
  assert.equal(p.minFinalCltv, 10);
});

test('BOLT 11: encoding with RFC 6979 reproduces the examples exactly', () => {
  const secret = Buffer.alloc(32, 0x11);
  const hash = Buffer.from('0001020304050607080900010203040506070809000102030405060708090102', 'hex');
  assert.equal(encodeInvoice({ currency: 'bc', timestamp: 1496314658, privateKey: BOLT11_KEY, fields: [['s', secret], ['p', hash], ['d', 'Please consider supporting this project'], ['9', DEFAULT_FEATURES]] }), DONATION);
  assert.equal(encodeInvoice({ currency: 'bc', amountMsat: 2000000000n, timestamp: 1496314658, privateKey: BOLT11_KEY, fields: [['s', secret], ['p', hash], ['h', Buffer.from('3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1', 'hex')], ['9', DEFAULT_FEATURES]] }), HASHED);
});

test('BOLT 11: invalid invoices are rejected', () => {
  assert.throws(() => decodeInvoice(`${DONATION.slice(0, -1)}x`), /checksum/);
  assert.throws(() => decodeInvoice('lnbc2500000001p1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq0lzc236j96a95uv0m3umg28gclm5lqxtqqwk32uuk4k6673k6n5kfvx3d2h8s295fad45fdhmusm8sjudfhlf6dcsxmfvkeywmjdkxcp99202x'), /millisatoshis/);
  assert.throws(() => decodeInvoice('lnbc2500x1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqrrzc4cvfue4zp3hggxp47ag7xnrlr8vgcmkjxk3j5jqethnumgkpqp23z9jclu3v0a7e0aruz366e9wqdykw6dxhdzcjjhldxq0w6wgqcnu43j'), /prefix/);
  assert.throws(() => decodeInvoice(DONATION.toUpperCase().replace('LNBC', 'lnbc')), /Mixed case/);
});

// --- x402 exact on Lightning ---

test('x402 lnbtc: the specification’s MCP request-hash vectors', () => {
  const base = { server: 'https://api.example.com/mcp', name: 'get_article', args: { article: 'A' } };
  assert.equal(mcpRequestHash(base), '03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4');
  assert.equal(mcpRequestHash({ ...base, args: { article: 'B' } }), 'b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678');
  assert.equal(mcpRequestHash({ ...base, name: 'delete_article' }), '3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455');
  assert.equal(mcpRequestHash({ ...base, server: 'https://other.example.com/mcp' }), '96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45');
});

test('x402 lnbtc: the specification’s invoice vector', () => {
  const inv = decodeInvoice(LNBTC_VECTOR);
  assert.equal(inv.payee, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(inv.amountMsat, 25000n);
  assert.equal(inv.descriptionHash, '0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018');
  assert.equal(inv.expiry, 300);
  assert.equal(sha256('0001020304050607080900010203040506070809000102030405060708090102'), inv.paymentHash);
});

async function lightningCase({ now = 2000000000, mutate } = {}) {
  const node = simulatedNode({ network: 'testnet', now: () => now });
  const server = 'https://shop.example/mcp';
  const requestHash = mcpRequestHash({ server, name: 'pay_order', args: { items: [{ sku: 'EGG-12', quantity: 2 }] } });
  const { invoice } = await node.createInvoice({ amountMsat: 640000n, descriptionHash: requestHash, expiry: 600 });
  const requirements = lnbtcRequirement({ network: LNBTC.testnet.network, amountMsat: 640000n, payTo: node.payTo, invoice, requestHash, server, maxTimeoutSeconds: 600 });
  checkChallengeInvoice(invoice, { network: requirements.network, amountMsat: 640000n, payTo: node.payTo, requestHash, maxTimeoutSeconds: 600, now });
  const { preimage } = await node.pay(invoice);
  const payload = { x402Version: 2, accepted: structuredClone(requirements), payload: { preimage } };
  mutate?.({ requirements, payload });
  return { requirements, payload, node };
}

test('x402 lnbtc: settlement accepts a valid proof once', async () => {
  const store = memoryStore();
  const { requirements, payload } = await lightningCase();
  const ok = await settleLnbtc({ requirements, payload, now: 2000000010, claim: store.claim });
  assert.equal(ok.success, true);
  assert.equal(ok.network, LNBTC.testnet.network);
  assert.equal(ok.transaction, decodeInvoice(requirements.extra.invoice).paymentHash);
  const again = await settleLnbtc({ requirements, payload, now: 2000000010, claim: store.claim });
  assert.equal(again.errorReason, 'duplicate_settlement');
});

test('x402 lnbtc: settlement rejects every kind of mismatch with the specified reason', async () => {
  const cases = [
    [({ payload }) => { payload.payload.preimage = '00'.repeat(32); }, 'invalid_exact_lnbtc_preimage_hash_mismatch'],
    [({ payload }) => { payload.payload.preimage = 'AB'.repeat(32); }, 'invalid_exact_lnbtc_preimage_malformed'],
    [({ payload }) => { delete payload.payload.preimage; }, 'invalid_exact_lnbtc_preimage_missing'],
    [({ payload }) => { payload.accepted.amount = '1'; }, 'invalid_exact_lnbtc_amount_mismatch'],
    [({ requirements, payload }) => { requirements.extra.requestHash = 'ab'.repeat(32); payload.accepted.extra.requestHash = 'ab'.repeat(32); }, 'invalid_exact_lnbtc_invoice_request_mismatch'],
    [({ payload }) => { payload.accepted.extra.requestHash = 'cd'.repeat(32); }, 'invalid_exact_lnbtc_request_mismatch'],
    [({ requirements, payload }) => { const pk = publicKey(7n).toString('hex'); requirements.payTo = pk; payload.accepted.payTo = pk; }, 'invalid_exact_lnbtc_invoice_payee_mismatch'],
    [({ payload }) => { payload.accepted.extra.paymentFlow = 'escrow'; }, 'invalid_exact_lnbtc_payment_flow'],
  ];
  for (const [mutate, reason] of cases) {
    const { requirements, payload } = await lightningCase({ mutate });
    const res = await settleLnbtc({ requirements, payload, now: 2000000010, claim: memoryStore().claim });
    assert.equal(res.errorReason, reason);
  }
  const { requirements, payload } = await lightningCase();
  const late = await settleLnbtc({ requirements, payload, now: 2000000000 + 600 + 61, claim: memoryStore().claim });
  assert.equal(late.errorReason, 'invalid_exact_lnbtc_invoice_expired');
});

// --- x402 exact on EVM (USDC) ---

test('x402 EVM: EIP-3009 authorisations recover to the payer, and the simulated facilitator checks them', async () => {
  const requirement = usdcRequirement({ network: 'eip155:84532', amount: '8128000', payTo: addressFromPrivateKey(99n), maxTimeoutSeconds: 300 });
  const now = 1800000000;
  const auth = signTransferAuthorization({ privateKey: 42n, requirement, now, nonce: `0x${'11'.repeat(32)}` });
  assert.equal(recoverTransferSigner(requirement, auth), addressFromPrivateKey(42n));
  const facilitator = simulatedEvmFacilitator({ claim: memoryStore().claim, now: () => now });
  const payload = { x402Version: 2, accepted: requirement, payload: auth };
  assert.deepEqual(await facilitator.verify(payload, requirement), { isValid: true, payer: addressFromPrivateKey(42n) });
  const tampered = structuredClone(payload);
  tampered.payload.authorization.value = '1';
  assert.equal((await facilitator.verify(tampered, requirement)).invalidReason, 'invalid_exact_evm_payload_signature');
  assert.equal((await facilitator.settle(payload, requirement)).success, true);
  assert.equal((await facilitator.settle(payload, requirement)).errorReason, 'duplicate_settlement');
  const expired = simulatedEvmFacilitator({ claim: memoryStore().claim, now: () => now + 301 });
  assert.equal((await expired.verify(payload, requirement)).invalidReason, 'invalid_exact_evm_payload_authorization_valid_before');
});

// --- Quotes and state ---

test('quotes round up in the business’s favour, and format plainly', () => {
  assert.equal(penceToMsat(1000, '80000'), 12500000n); // £10 at £80,000/BTC = 12,500 sats
  assert.equal(penceToMsat(1, '80000'), 12500n); // 1p = 12.5 sats
  assert.equal(penceToMsat(1, '79999.99'), 12501n); // 12,500.0016 msat, rounded up
  assert.equal(penceToUsdcUnits(1800, '1.27'), 22860000n);
  assert.equal(formatSats(13625000n), '13,625 sats');
  assert.equal(formatUsdc(8128000n), '8.128 USDC');
  assert.equal(formatUsdc(22860000n), '22.86 USDC');
  assert.throws(() => penceToMsat(1, 'lots'), /positive number/);
});

test('request state is integrity-protected', () => {
  const secret = Buffer.alloc(32, 7);
  const token = sealState(secret, { op: 'pay_order', exp: 5 });
  assert.deepEqual(openState(secret, token), { op: 'pay_order', exp: 5 });
  assert.equal(openState(Buffer.alloc(32, 8), token), null);
  assert.equal(openState(secret, `${token.slice(0, -2)}xx`), null);
  assert.equal(openState(secret, 'nonsense'), null);
});

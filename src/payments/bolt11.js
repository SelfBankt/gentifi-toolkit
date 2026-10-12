import { createHash } from 'node:crypto';
import { bigIntToBytes, bytesToBigInt, compress, publicKey, recover, sign } from './secp256k1.js';

/**
 * BOLT 11 Lightning invoices: strict decoding with signature recovery, and
 * encoding (for the simulated node and tests). Follows lightning/bolts 11.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const TAGS = { p: 1, r: 3, 9: 5, x: 6, f: 9, d: 13, s: 16, n: 19, h: 23, c: 24, m: 27 };
const TAG_NAMES = Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [v, k]));
const MULTIPLIERS = { m: 100000000n, u: 100000n, n: 100n }; // msat per unit
const CURRENCIES = ['bc', 'tb', 'tbs', 'bcrt', 'sb'];

export class InvoiceError extends Error {}

const sha256 = (data) => createHash('sha256').update(data).digest();

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function bech32Decode(str) {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new InvoiceError('Mixed case');
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new InvoiceError('Missing separator or data');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new InvoiceError(`Invalid character "${c}"`);
    return v;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new InvoiceError('Invalid checksum');
  return { hrp, words: data.slice(0, -6) };
}

function bech32Encode(hrp, words) {
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...checksum].map((w) => CHARSET[w]).join('');
}

/** 5-bit words to bytes; trailing bits that don't make a whole byte are dropped. */
function wordsToBytes(words, { pad = false } = {}) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Buffer.from(out);
}

function bytesToWords(bytes) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

const wordsToInt = (words) => words.reduce((n, w) => n * 32n + BigInt(w), 0n);
function intToWords(n, minLength = 1) {
  const out = [];
  let v = BigInt(n);
  do {
    out.unshift(Number(v & 31n));
    v >>= 5n;
  } while (v > 0n);
  while (out.length < minLength) out.unshift(0);
  return out;
}

/** "lnbc250n" -> { currency: 'bc', amountMsat: 25000n } */
export function parseHrp(hrp) {
  const m = /^ln([a-z]+?)(\d+)?([munp])?$/.exec(hrp);
  if (!m || !CURRENCIES.includes(m[1])) throw new InvoiceError(`Unknown prefix "${hrp}"`);
  const [, currency, digits, multiplier] = m;
  if (!digits) {
    if (multiplier) throw new InvoiceError('Multiplier without amount');
    return { currency, amountMsat: null };
  }
  if (digits.length > 1 && digits[0] === '0') throw new InvoiceError('Amount has leading zeros');
  const value = BigInt(digits);
  let amountMsat;
  if (!multiplier) amountMsat = value * 100000000000n;
  else if (multiplier === 'p') {
    if (value % 10n !== 0n) throw new InvoiceError('Pico-bitcoin amount is not a whole number of millisatoshis');
    amountMsat = value / 10n;
  } else amountMsat = value * MULTIPLIERS[multiplier];
  if (amountMsat <= 0n) throw new InvoiceError('Amount must be positive');
  return { currency, amountMsat };
}

/** Shortest amount text for an invoice prefix. */
function formatAmount(msat) {
  const v = BigInt(msat);
  if (v % 100000000000n === 0n) return `${v / 100000000000n}`;
  for (const [unit, per] of Object.entries(MULTIPLIERS)) if (v % per === 0n) return `${v / per}${unit}`;
  return `${v * 10n}p`;
}

/**
 * Strictly decodes and verifies an invoice. The payee key is recovered from the
 * signature; when an `n` field is present it must match.
 */
export function decodeInvoice(invoice) {
  if (typeof invoice !== 'string' || invoice.length < 8) throw new InvoiceError('Not an invoice');
  const { hrp, words } = bech32Decode(invoice.trim());
  const { currency, amountMsat } = parseHrp(hrp);
  if (words.length < 7 + 104) throw new InvoiceError('Too short');
  const sigWords = words.slice(-104);
  const dataWords = words.slice(0, -104);
  const timestamp = Number(wordsToInt(dataWords.slice(0, 7)));

  const fields = [];
  const out = { currency, amountMsat, timestamp, expiry: 3600, minFinalCltv: 18, descriptions: [], descriptionHashes: [], fields };
  let i = 7;
  while (i < dataWords.length) {
    if (i + 3 > dataWords.length) throw new InvoiceError('Truncated tagged field');
    const type = dataWords[i];
    const len = dataWords[i + 1] * 32 + dataWords[i + 2];
    const value = dataWords.slice(i + 3, i + 3 + len);
    if (value.length !== len) throw new InvoiceError('Truncated tagged field');
    i += 3 + len;
    const tag = TAG_NAMES[type] ?? `unknown-${type}`;
    fields.push({ tag, words: value });
    switch (tag) {
      case 'p': if (len === 52 && !out.paymentHash) out.paymentHash = wordsToBytes(value).toString('hex'); break;
      case 's': if (len === 52 && !out.paymentSecret) out.paymentSecret = wordsToBytes(value).toString('hex'); break;
      case 'h': if (len === 52) out.descriptionHashes.push(wordsToBytes(value).toString('hex')); break;
      case 'd': out.descriptions.push(wordsToBytes(value).toString('utf8')); break;
      case 'x': out.expiry = Number(wordsToInt(value)); break;
      case 'c': out.minFinalCltv = Number(wordsToInt(value)); break;
      case 'n': if (len === 53) out.payeeField = wordsToBytes(value).toString('hex'); break;
      case '9': out.features = value; break;
      default: break; // r, f, m and unknown fields are allowed and ignored here
    }
  }
  if (!out.paymentHash) throw new InvoiceError('Missing payment hash');

  const sigBytes = wordsToBytes(sigWords);
  if (sigBytes.length !== 65) throw new InvoiceError('Bad signature length');
  const r = bytesToBigInt(sigBytes.subarray(0, 32));
  const s = bytesToBigInt(sigBytes.subarray(32, 64));
  const recid = sigBytes[64];
  const message = sha256(Buffer.concat([Buffer.from(hrp, 'utf8'), wordsToBytes(dataWords, { pad: true })]));
  const point = recover(message, r, s, recid);
  if (!point) throw new InvoiceError('Invalid signature');
  out.payee = compress(point).toString('hex');
  if (out.payeeField && out.payeeField !== out.payee) throw new InvoiceError('Signature does not match the payee field');
  out.description = out.descriptions[0];
  out.descriptionHash = out.descriptionHashes[0];
  return out;
}

/**
 * Builds and signs an invoice. `fields` is an ordered list such as
 * [['s', secretBytes], ['p', hashBytes], ['h', descHashBytes], ['x', 300], ['9', features]].
 */
export function encodeInvoice({ currency = 'bc', amountMsat = null, timestamp, fields, privateKey }) {
  const hrp = `ln${currency}${amountMsat == null ? '' : formatAmount(amountMsat)}`;
  const words = intToWords(timestamp, 7);
  for (const [tag, value] of fields) {
    let w;
    if (tag === 'x' || tag === 'c') w = intToWords(value);
    else if (tag === 'd') w = bytesToWords(Buffer.from(value, 'utf8'));
    else if (tag === '9') w = value;
    else w = bytesToWords(Buffer.from(value));
    words.push(TAGS[tag], (w.length >> 5) & 31, w.length & 31, ...w);
  }
  const message = sha256(Buffer.concat([Buffer.from(hrp, 'utf8'), wordsToBytes(words, { pad: true })]));
  const { r, s, recid } = sign(message, privateKey);
  const sig = Buffer.concat([bigIntToBytes(r), bigIntToBytes(s), Buffer.from([recid])]);
  return bech32Encode(hrp, [...words, ...bytesToWords(sig)]);
}

/** Feature bits var_onion_optin (8) and payment_secret (14), both required: what current nodes set. */
export const DEFAULT_FEATURES = [16, 8, 0]; // "sgq" in the BOLT 11 examples: bits 8 and 14

export { publicKey };

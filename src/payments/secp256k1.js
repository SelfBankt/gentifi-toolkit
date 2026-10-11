import { createHmac } from 'node:crypto';

/**
 * secp256k1 arithmetic with BigInt: public keys, ECDSA signature recovery and
 * deterministic (RFC 6979) signing with low-S normalisation.
 *
 * Recovery and verification only touch public data. Signing is NOT constant
 * time: the toolkit uses it for its simulated Lightning node, test vectors and
 * the demo payer, never for keys that hold real money.
 */

export const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  z: 1n,
};
const INFINITY = { x: 0n, y: 1n, z: 0n };

const mod = (a, m = P) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function invert(a, m = P) {
  let [lm, hm, low, high] = [1n, 0n, mod(a, m), m];
  while (low > 1n) {
    const q = high / low;
    [lm, hm] = [hm - lm * q, lm];
    [low, high] = [high - low * q, low];
  }
  return mod(lm, m);
}

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

// Jacobian coordinates; the curve has a = 0.
function double(p) {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const ysq = (p.y * p.y) % P;
  const s = (4n * p.x * ysq) % P;
  const m = (3n * p.x * p.x) % P;
  const x = mod(m * m - 2n * s);
  const y = mod(m * (s - x) - 8n * ysq * ysq);
  const z = (2n * p.y * p.z) % P;
  return { x, y, z };
}

function add(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = (p.z * p.z) % P;
  const z2z2 = (q.z * q.z) % P;
  const u1 = (p.x * z2z2) % P;
  const u2 = (q.x * z1z1) % P;
  const s1 = (((p.y * q.z) % P) * z2z2) % P;
  const s2 = (((q.y * p.z) % P) * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const h2 = (h * h) % P;
  const h3 = (h2 * h) % P;
  const u1h2 = (u1 * h2) % P;
  const x = mod(r * r - h3 - 2n * u1h2);
  const y = mod(r * (u1h2 - x) - s1 * h3);
  const z = (((h * p.z) % P) * q.z) % P;
  return { x, y, z };
}

function multiply(point, k) {
  let result = INFINITY;
  let addend = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) result = add(result, addend);
    addend = double(addend);
    n >>= 1n;
  }
  return result;
}

function affine(p) {
  if (p.z === 0n) return null;
  const zi = invert(p.z);
  const zi2 = (zi * zi) % P;
  return { x: (p.x * zi2) % P, y: (((p.y * zi2) % P) * zi) % P };
}

export const bytesToBigInt = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
export const bigIntToBytes = (n, length = 32) => Buffer.from(n.toString(16).padStart(length * 2, '0'), 'hex');

/** Point for an x coordinate and y parity (0 even, 1 odd), or null if x is not on the curve. */
function lift(x, odd) {
  if (x >= P) return null;
  const y2 = mod(x * x * x + 7n);
  let y = powMod(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null;
  if ((y & 1n) !== BigInt(odd)) y = P - y;
  return { x, y, z: 1n };
}

export function compress({ x, y }) {
  return Buffer.concat([Buffer.from([y & 1n ? 0x03 : 0x02]), bigIntToBytes(x)]);
}

export function uncompressed({ x, y }) {
  return Buffer.concat([bigIntToBytes(x), bigIntToBytes(y)]);
}

/** Parses a 33-byte compressed public key, or returns null. */
export function decompress(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return null;
  const p = lift(bytesToBigInt(b.subarray(1)), b[0] === 3 ? 1 : 0);
  return p && { x: p.x, y: p.y };
}

export function publicKeyPoint(privateKey) {
  const d = typeof privateKey === 'bigint' ? privateKey : bytesToBigInt(privateKey);
  if (d <= 0n || d >= N) throw new Error('Private key out of range');
  return affine(multiply(G, d));
}

export function publicKey(privateKey) {
  return compress(publicKeyPoint(privateKey));
}

/**
 * Recovers the signer's public key point from a 32-byte message hash and a
 * signature (r, s, recovery id 0 to 3). Returns null for invalid signatures.
 */
export function recover(hash, r, s, recid) {
  if (r <= 0n || r >= N || s <= 0n || s >= N || recid < 0 || recid > 3) return null;
  const x = r + (recid >= 2 ? N : 0n);
  const R = lift(x, recid & 1);
  if (!R) return null;
  const e = mod(bytesToBigInt(hash), N);
  const rInv = invert(r, N);
  const sR = multiply(R, s);
  const eG = multiply(G, mod(-e, N));
  const Q = affine(multiply(add(sR, eG), rInv));
  return Q;
}

/** RFC 6979 deterministic nonce for secp256k1 with HMAC-SHA256. */
function rfc6979(hash, d) {
  const x = bigIntToBytes(d);
  const h = bigIntToBytes(mod(bytesToBigInt(hash), N));
  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  k = hmac(k, v, Buffer.from([0]), x, h);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([1]), x, h);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = bytesToBigInt(v);
    if (candidate > 0n && candidate < N) return candidate;
    k = hmac(k, v, Buffer.from([0]));
    v = hmac(k, v);
  }
}

/** Signs a 32-byte hash. Returns { r, s, recid } with s normalised to the low half. */
export function sign(hash, privateKey) {
  const d = typeof privateKey === 'bigint' ? privateKey : bytesToBigInt(privateKey);
  if (d <= 0n || d >= N) throw new Error('Private key out of range');
  const e = mod(bytesToBigInt(hash), N);
  const k = rfc6979(hash, d);
  const R = affine(multiply(G, k));
  const r = mod(R.x, N);
  let s = mod(invert(k, N) * (e + r * d), N);
  let recid = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
  if (s > HALF_N) {
    s = N - s;
    recid ^= 1;
  }
  return { r, s, recid };
}

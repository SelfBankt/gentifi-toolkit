import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorrSign, schnorrVerify, sharedX, xOnlyPublicKey } from './secp256k1.js';

/**
 * The parts of Nostr that Nostr Wallet Connect needs: signed events (NIP-01),
 * and encrypted content, both the current NIP-44 v2 and the older NIP-04 that
 * some wallets still use.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (data) => createHash('sha256').update(data).digest();
const hex = (b) => Buffer.from(b).toString('hex');

export const getPublicKey = (secretKey) => hex(xOnlyPublicKey(Buffer.from(secretKey, 'hex')));

/** The event id: SHA-256 of the NIP-01 serialisation. */
export function eventId({ pubkey, created_at, kind, tags, content }) {
  return hex(sha256(Buffer.from(JSON.stringify([0, pubkey, created_at, kind, tags, content]), 'utf8')));
}

/** Signs an event template with a hex secret key. */
export function finalizeEvent({ kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }, secretKey) {
  const event = { pubkey: getPublicKey(secretKey), created_at, kind, tags, content };
  const id = eventId(event);
  return { id, ...event, sig: hex(schnorrSign(Buffer.from(id, 'hex'), Buffer.from(secretKey, 'hex'))) };
}

export function verifyEvent(event) {
  if (!event || !HEX64.test(event.id ?? '') || !HEX64.test(event.pubkey ?? '') || !/^[0-9a-f]{128}$/.test(event.sig ?? '')) return false;
  if (eventId(event) !== event.id) return false;
  return schnorrVerify(Buffer.from(event.sig, 'hex'), Buffer.from(event.id, 'hex'), Buffer.from(event.pubkey, 'hex'));
}

// --- NIP-04 (legacy): AES-256-CBC with the raw shared x coordinate as the key ---

export function nip04Encrypt(secretKey, publicKey, text) {
  const key = sharedX(Buffer.from(secretKey, 'hex'), Buffer.from(publicKey, 'hex'));
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${body.toString('base64')}?iv=${iv.toString('base64')}`;
}

export function nip04Decrypt(secretKey, publicKey, payload) {
  const [body, iv] = String(payload).split('?iv=');
  if (!body || !iv) throw new Error('Not a NIP-04 payload');
  const key = sharedX(Buffer.from(secretKey, 'hex'), Buffer.from(publicKey, 'hex'));
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

// --- NIP-44 v2: ChaCha20 with HMAC-SHA256, keys from HKDF, padded lengths ---

const hmac = (key, ...data) => {
  const h = createHmac('sha256', key);
  for (const d of data) h.update(d);
  return h.digest();
};

/** HKDF-Expand (RFC 5869) from an already-extracted key. */
function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i += 1) {
    previous = hmac(prk, previous, info, Buffer.from([i]));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** The conversation key two parties share: HKDF-Extract(salt "nip44-v2", shared x). */
export function nip44ConversationKey(secretKey, publicKey) {
  return hmac(Buffer.from('nip44-v2'), sharedX(Buffer.from(secretKey, 'hex'), Buffer.from(publicKey, 'hex')));
}

export function nip44PaddedLength(length) {
  if (length <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}

function messageKeys(conversationKey, nonce) {
  const keys = hkdfExpand(conversationKey, nonce, 76);
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

// OpenSSL's ChaCha20 takes a 16-byte IV: a 32-bit little-endian counter (0 here) and the 12-byte nonce
const chacha20 = (key, nonce, data) => {
  const cipher = createCipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), nonce]));
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

export function nip44Encrypt(conversationKey, text, nonce = randomBytes(32)) {
  const plain = Buffer.from(text, 'utf8');
  if (plain.length < 1 || plain.length > 65535) throw new Error('NIP-44 messages must be 1 to 65535 bytes');
  const padded = Buffer.alloc(2 + nip44PaddedLength(plain.length));
  padded.writeUInt16BE(plain.length, 0);
  plain.copy(padded, 2);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmac(hmacKey, nonce, ciphertext);
  return Buffer.concat([Buffer.from([2]), nonce, ciphertext, mac]).toString('base64');
}

export function nip44Decrypt(conversationKey, payload) {
  const data = Buffer.from(String(payload), 'base64');
  if (data.length < 99 || data[0] !== 2) throw new Error('Not a NIP-44 v2 payload');
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  if (!timingSafeEqual(hmac(hmacKey, nonce, ciphertext), mac)) throw new Error('NIP-44 message authentication failed');
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  const length = padded.readUInt16BE(0);
  if (length < 1 || padded.length !== 2 + nip44PaddedLength(length)) throw new Error('NIP-44 padding is invalid');
  return padded.subarray(2, 2 + length).toString('utf8');
}

/** Encrypts for a peer with the named scheme ("nip44_v2" or "nip04"). */
export function encryptFor(scheme, secretKey, publicKey, text) {
  return scheme === 'nip04' ? nip04Encrypt(secretKey, publicKey, text) : nip44Encrypt(nip44ConversationKey(secretKey, publicKey), text);
}

/** Decrypts from a peer, recognising either scheme from the payload's shape. */
export function decryptFrom(secretKey, publicKey, payload) {
  return String(payload).includes('?iv=') ? nip04Decrypt(secretKey, publicKey, payload) : nip44Decrypt(nip44ConversationKey(secretKey, publicKey), payload);
}

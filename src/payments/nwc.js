import { randomBytes } from 'node:crypto';
import { decodeInvoice } from './bolt11.js';
import { decryptFrom, encryptFor, finalizeEvent, getPublicKey, verifyEvent } from './nostr.js';
import { connectWebSocket } from './websocket.js';

/**
 * Nostr Wallet Connect (NIP-47). A connection string from the user's wallet
 * (Alby Hub and others) lets an app ask that wallet to pay or create invoices,
 * within the budget the user set in the wallet. Requests and replies are
 * encrypted Nostr events passed through a relay.
 *
 *   nostr+walletconnect://<wallet pubkey>?relay=wss://relay.example&secret=<hex>
 */

export const NWC_INFO = 13194;
export const NWC_REQUEST = 23194;
export const NWC_RESPONSE = 23195;
const HEX64 = /^[0-9a-f]{64}$/;

export class NwcError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NwcError';
    this.code = code;
  }
}

export function parseNwcUri(uri) {
  let u;
  try {
    u = new URL(String(uri).trim());
  } catch {
    throw new Error('Not a Nostr Wallet Connect string');
  }
  if (u.protocol !== 'nostr+walletconnect:' && u.protocol !== 'nostrwalletconnect:') throw new Error('A Nostr Wallet Connect string starts with nostr+walletconnect://');
  const walletPubkey = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  const secret = (u.searchParams.get('secret') ?? '').toLowerCase();
  const relays = u.searchParams.getAll('relay');
  if (!HEX64.test(walletPubkey)) throw new Error('The connection string has no valid wallet public key');
  if (!HEX64.test(secret)) throw new Error('The connection string has no valid secret');
  if (!relays.length) throw new Error('The connection string names no relay');
  return { walletPubkey, secret, relays, lud16: u.searchParams.get('lud16') ?? undefined };
}

/** Wraps a relay connection with subscriptions and publish acknowledgements. */
async function openRelay(url, connect) {
  const ws = await connect(url);
  const subs = new Map();
  const oks = new Map();
  ws.onMessage((text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    if (msg[0] === 'EVENT') subs.get(msg[1])?.onEvent(msg[2]);
    else if (msg[0] === 'EOSE') subs.get(msg[1])?.onEose();
    else if (msg[0] === 'OK') oks.get(msg[1])?.(msg[2], msg[3]);
  });
  let counter = 0;
  return {
    subscribe(filter, { onEvent = () => {}, onEose = () => {} }) {
      const id = `g${(counter += 1)}${randomBytes(3).toString('hex')}`;
      subs.set(id, { onEvent, onEose });
      ws.send(JSON.stringify(['REQ', id, filter]));
      return () => {
        subs.delete(id);
        try { ws.send(JSON.stringify(['CLOSE', id])); } catch { /* already closed */ }
      };
    },
    publish(event, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          oks.delete(event.id);
          reject(new Error('The relay did not acknowledge the request'));
        }, timeoutMs);
        oks.set(event.id, (ok, message) => {
          clearTimeout(timer);
          oks.delete(event.id);
          if (ok) resolve();
          else reject(new Error(`The relay refused the request: ${message}`));
        });
        ws.send(JSON.stringify(['EVENT', event]));
      });
    },
    close: () => ws.close(),
  };
}

/** Fetches the wallet's info event: the methods it supports and the encryption it accepts. */
function readInfo(relay, walletPubkey, timeoutMs) {
  return new Promise((resolve) => {
    let info = null;
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve(info);
    };
    const timer = setTimeout(done, timeoutMs);
    const stop = relay.subscribe({ kinds: [NWC_INFO], authors: [walletPubkey], limit: 1 }, {
      onEvent: (e) => {
        if (!verifyEvent(e) || e.pubkey !== walletPubkey) return;
        info = {
          methods: String(e.content).split(/\s+/).filter(Boolean),
          encryption: (e.tags.find((t) => t[0] === 'encryption')?.[1] ?? 'nip04').split(/\s+/),
        };
      },
      onEose: done,
    });
  });
}

/**
 * A client for one wallet connection. Each call opens the relay, sends one
 * encrypted request signed with the connection's secret, and waits for the
 * wallet's reply.
 */
export function nwcClient(uri, { connect = connectWebSocket, timeoutMs = 60000 } = {}) {
  const { walletPubkey, secret, relays } = parseNwcUri(uri);
  const clientPubkey = getPublicKey(secret);

  async function request(method, params = {}) {
    const relay = await openRelay(relays[0], connect);
    try {
      const info = await readInfo(relay, walletPubkey, Math.min(timeoutMs, 10000));
      if (info && info.methods.length && !info.methods.includes(method)) throw new NwcError('NOT_IMPLEMENTED', `This wallet doesn't allow ${method}`);
      const scheme = info?.encryption.includes('nip44_v2') ? 'nip44_v2' : 'nip04';
      const event = finalizeEvent({
        kind: NWC_REQUEST,
        tags: [['p', walletPubkey], ...(scheme === 'nip44_v2' ? [['encryption', 'nip44_v2']] : [])],
        content: encryptFor(scheme, secret, walletPubkey, JSON.stringify({ method, params })),
      }, secret);
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new NwcError('TIMEOUT', 'The wallet did not reply in time'));
        }, timeoutMs);
        const stop = relay.subscribe({ kinds: [NWC_RESPONSE], authors: [walletPubkey], '#e': [event.id] }, {
          onEvent: (e) => {
            if (!verifyEvent(e) || e.pubkey !== walletPubkey) return;
            if (!e.tags.some((t) => t[0] === 'p' && t[1] === clientPubkey)) return;
            let body;
            try {
              body = JSON.parse(decryptFrom(secret, walletPubkey, e.content));
            } catch {
              return;
            }
            clearTimeout(timer);
            stop();
            if (body.error) reject(new NwcError(body.error.code ?? 'OTHER', body.error.message));
            else resolve(body.result);
          },
        });
      });
      await relay.publish(event);
      return await reply;
    } finally {
      relay.close();
    }
  }

  return {
    walletPubkey,
    clientPubkey,
    request,
    getInfo: () => request('get_info'),
    /** Pays a BOLT 11 invoice. Resolves to { preimage, fees_paid }. */
    payInvoice: (invoice) => request('pay_invoice', { invoice }),
    /** Creates an invoice in the wallet. Amount in millisatoshis. */
    makeInvoice: ({ amountMsat, descriptionHash, description, expiry }) => request('make_invoice', {
      amount: Number(amountMsat),
      ...(descriptionHash ? { description_hash: descriptionHash } : {}),
      ...(description ? { description } : {}),
      ...(expiry ? { expiry } : {}),
    }),
  };
}

/**
 * A stand-in wallet service for development and tests. It answers NWC requests
 * on a relay, pays through `pay(invoice)` and creates invoices through
 * `makeInvoice(...)`, and refuses payments over its budget with QUOTA_EXCEEDED,
 * as real wallets do. No funds move unless the functions you pass move them.
 */
export async function simulatedNwcWallet({ relayUrl, pay, makeInvoice, budgetMsat = 50000000n, encryption = ['nip44_v2', 'nip04'], connect = connectWebSocket, network = 'testnet' }) {
  const walletSecret = randomBytes(32).toString('hex');
  const connectionSecret = randomBytes(32).toString('hex');
  const walletPubkey = getPublicKey(walletSecret);
  const allowed = getPublicKey(connectionSecret);
  const methods = ['get_info', ...(pay ? ['pay_invoice'] : []), ...(makeInvoice ? ['make_invoice'] : [])];
  let spent = 0n;
  const relay = await openRelay(relayUrl, connect);
  await relay.publish(finalizeEvent({ kind: NWC_INFO, tags: [['encryption', encryption.join(' ')]], content: methods.join(' ') }, walletSecret));

  async function handle(method, params) {
    if (!methods.includes(method)) throw new NwcError('NOT_IMPLEMENTED', `${method} is not supported`);
    if (method === 'get_info') return { alias: 'Simulated wallet', network, methods };
    if (method === 'pay_invoice') {
      const amount = decodeInvoice(params.invoice).amountMsat ?? BigInt(params.amount ?? 0);
      if (spent + amount > budgetMsat) throw new NwcError('QUOTA_EXCEEDED', 'This payment is over the budget set for this connection');
      const { preimage } = await pay(params.invoice);
      spent += amount;
      return { preimage, fees_paid: 0 };
    }
    const made = await makeInvoice({ amountMsat: BigInt(params.amount), descriptionHash: params.description_hash, expiry: params.expiry });
    return { type: 'incoming', invoice: made.invoice, payment_hash: made.paymentHash, amount: params.amount };
  }

  relay.subscribe({ kinds: [NWC_REQUEST], '#p': [walletPubkey] }, {
    onEvent: async (e) => {
      if (!verifyEvent(e) || e.pubkey !== allowed) return; // only the connection this wallet issued
      const scheme = String(e.content).includes('?iv=') ? 'nip04' : 'nip44_v2';
      if (!encryption.includes(scheme)) return;
      let method;
      let result = null;
      let error = null;
      try {
        const body = JSON.parse(decryptFrom(walletSecret, e.pubkey, e.content));
        method = body.method;
        result = await handle(body.method, body.params ?? {});
      } catch (err) {
        error = { code: err instanceof NwcError ? err.code : 'INTERNAL', message: err.message };
      }
      const reply = finalizeEvent({
        kind: NWC_RESPONSE,
        tags: [['p', e.pubkey], ['e', e.id], ...(scheme === 'nip44_v2' ? [['encryption', 'nip44_v2']] : [])],
        content: encryptFor(scheme, walletSecret, e.pubkey, JSON.stringify({ result_type: method, error, result })),
      }, walletSecret);
      relay.publish(reply).catch(() => {});
    },
  });

  return {
    uri: `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(relayUrl)}&secret=${connectionSecret}`,
    walletPubkey,
    get spentMsat() { return spent; },
    close: () => relay.close(),
  };
}

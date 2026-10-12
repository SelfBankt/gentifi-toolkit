import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DEFAULT_FEATURES, decodeInvoice, encodeInvoice } from './bolt11.js';
import { N, bytesToBigInt, publicKey } from './secp256k1.js';
import { nwcClient } from './nwc.js';
import { LNBTC } from './x402.js';

/**
 * Lightning node adapters. Each one can issue invoices (the business side) and
 * some can pay them (the demo payer). Money only moves through real nodes.
 */

const sha256 = (data) => createHash('sha256').update(data).digest();

export function randomPrivateKey() {
  for (;;) {
    const k = randomBytes(32);
    const n = bytesToBigInt(k);
    if (n > 0n && n < N) return k;
  }
}

/**
 * A simulated node for development and the Gentified test. It signs real BOLT 11
 * invoices with its own key and "pays" only its own invoices. No funds move.
 */
export function simulatedNode({ network = 'testnet', privateKey = randomPrivateKey(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const net = LNBTC[network];
  if (!net) throw new Error(`Unknown Lightning network "${network}"`);
  const payTo = publicKey(privateKey).toString('hex');
  const issued = new Map();
  return {
    simulated: true,
    kind: 'simulated',
    network: net.network,
    payTo,
    async createInvoice({ amountMsat, descriptionHash, expiry }) {
      const preimage = randomBytes(32);
      const paymentHash = sha256(preimage);
      const invoice = encodeInvoice({
        currency: net.currency,
        amountMsat: BigInt(amountMsat),
        timestamp: now(),
        privateKey,
        fields: [['s', randomBytes(32)], ['p', paymentHash], ['h', Buffer.from(descriptionHash, 'hex')], ['x', expiry], ['9', DEFAULT_FEATURES]],
      });
      issued.set(paymentHash.toString('hex'), { invoice, preimage: preimage.toString('hex') });
      return { invoice, paymentHash: paymentHash.toString('hex') };
    },
    /** Settles one of this node's own invoices, as if a payment had arrived. */
    async pay(invoice) {
      const inv = decodeInvoice(invoice);
      const known = issued.get(inv.paymentHash);
      if (!known || known.invoice !== invoice) throw new Error('This simulated node did not issue that invoice');
      if (now() > inv.timestamp + inv.expiry) throw new Error('Invoice expired');
      return { status: 'paid', preimage: known.preimage, paymentHash: inv.paymentHash, amountMsat: String(inv.amountMsat) };
    },
  };
}

/**
 * A wallet reached over Nostr Wallet Connect (NIP-47), such as Alby Hub. The
 * business side asks it to make invoices (make_invoice); a payer asks it to pay
 * them (pay_invoice), within the budget set in the wallet. `payTo` must be the
 * wallet's own node key: a custodial wallet shared by many users won't do, as
 * the x402 Lightning scheme requires each business to have its own key.
 */
export function nwcNode({ uri, network = 'testnet', payTo, connect }) {
  const net = LNBTC[network];
  if (!net) throw new Error(`Unknown Lightning network "${network}"`);
  const client = nwcClient(uri, connect ? { connect } : {});
  return {
    simulated: false,
    kind: 'nwc',
    network: net.network,
    payTo,
    async createInvoice({ amountMsat, descriptionHash, expiry }) {
      const made = await client.makeInvoice({ amountMsat, descriptionHash, expiry });
      return { invoice: made.invoice, paymentHash: made.payment_hash ?? decodeInvoice(made.invoice).paymentHash };
    },
    async pay(invoice) {
      const paid = await client.payInvoice(invoice);
      return { status: 'paid', preimage: paid.preimage };
    },
  };
}

/**
 * An LND node over its REST API. The business side needs only an invoice
 * macaroon (it can create invoices but not spend). The demo payer uses a
 * macaroon allowed to send payments.
 */
export async function lndNode({ url, macaroon, tlsCert, network = 'testnet', payTo }) {
  const net = LNBTC[network];
  if (!net) throw new Error(`Unknown Lightning network "${network}"`);
  if (!url || !macaroon) throw new Error('An LND node needs its REST url and a macaroon');
  const base = new URL(url);
  const ca = tlsCert ? await readFile(tlsCert) : undefined;
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(new URL(path, base), {
      method,
      ca,
      headers: { 'Grpc-Metadata-macaroon': macaroon, 'content-type': 'application/json' },
      timeout: 60000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text || '{}');
        } catch {
          return reject(new Error(`LND ${path} returned HTTP ${res.statusCode}`));
        }
        if (res.statusCode >= 400) return reject(new Error(`LND ${path}: ${json.message ?? json.error ?? `HTTP ${res.statusCode}`}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`LND ${path} timed out`)));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  return {
    simulated: false,
    kind: 'lnd',
    network: net.network,
    payTo,
    async createInvoice({ amountMsat, descriptionHash, expiry }) {
      const res = await call('POST', '/v1/invoices', {
        value_msat: String(amountMsat),
        description_hash: Buffer.from(descriptionHash, 'hex').toString('base64'),
        expiry: String(expiry),
      });
      return { invoice: res.payment_request, paymentHash: Buffer.from(res.r_hash, 'base64').toString('hex') };
    },
    async pay(invoice) {
      const res = await call('POST', '/v1/channels/transactions', { payment_request: invoice });
      if (res.payment_error) throw new Error(res.payment_error);
      return { status: 'paid', preimage: Buffer.from(res.payment_preimage, 'base64').toString('hex') };
    },
  };
}

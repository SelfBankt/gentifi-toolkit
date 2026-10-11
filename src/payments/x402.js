import { createHash, randomBytes } from 'node:crypto';
import { InvoiceError, decodeInvoice } from './bolt11.js';
import { jcs } from './jcs.js';
import { keccak256 } from './keccak.js';
import { bigIntToBytes, bytesToBigInt, recover, sign, uncompressed, publicKeyPoint } from './secp256k1.js';

/**
 * x402 version 2 (github.com/x402-foundation/x402): the PaymentRequired,
 * PaymentPayload and SettlementResponse shapes, the MCP transport keys, the
 * `exact` scheme on Lightning (`lnbtc`, with request binding) and the `exact`
 * scheme on EVM chains, using EIP-3009 (USDC) or Permit2 (USDT and any other
 * ERC-20 without EIP-3009).
 */

export const X402_VERSION = 2;
export const MCP_PAYMENT_KEY = 'x402/payment';
export const MCP_PAYMENT_RESPONSE_KEY = 'x402/payment-response';

const sha256 = (data) => createHash('sha256').update(data).digest();
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const POSITIVE_INT = /^[1-9][0-9]*$/;

// --- Lightning: exact on lnbtc ---

export const LNBTC = {
  mainnet: { network: 'lnbtc:000000000019d6689c085ae165831e93', currency: 'bc' },
  testnet: { network: 'lnbtc:000000000933ea01ad0ee984209779ba', currency: 'tb' },
};
const LNBTC_CURRENCY = Object.fromEntries(Object.values(LNBTC).map((n) => [n.network, n.currency]));
export const isLnbtc = (network) => typeof network === 'string' && network.startsWith('lnbtc:');

const MCP_DOMAIN = 'x402:exact:lnbtc:bolt11:mcp:1';
const metaValueHash = (meta, name) => (Object.hasOwn(meta, name)
  ? sha256(Buffer.concat([Buffer.from([1]), Buffer.from(jcs(meta[name]), 'utf8')])).toString('hex')
  : sha256(Buffer.from([0])).toString('hex'));

/**
 * Request hash for an MCP tools/call under the `mcp:1` profile: SHA-256 of the
 * JCS-encoded binding object. It goes into the invoice's description hash.
 */
export function mcpRequestHash({ server, name, args = {}, metadata = [], meta = {} }) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  const binding = {
    domain: MCP_DOMAIN,
    server,
    method: 'tools/call',
    name,
    arguments: args,
    metadata: metadata.map((n) => ({ name: n, valueHash: metaValueHash(meta, n) })),
  };
  return sha256(Buffer.from(jcs(binding), 'utf8')).toString('hex');
}

/** The checks a server must run on its own invoice before offering it (lnbtc spec, PaymentRequirements). */
export function checkChallengeInvoice(invoice, { network, amountMsat, payTo, requestHash, maxTimeoutSeconds, now, skew = 60 }) {
  const inv = decodeInvoice(invoice);
  const problems = [];
  if (inv.amountMsat !== BigInt(amountMsat)) problems.push('amount');
  if (inv.currency !== LNBTC_CURRENCY[network]) problems.push('currency');
  if (inv.descriptionHashes.length !== 1 || inv.descriptions.length || inv.descriptionHash !== requestHash) problems.push('description hash');
  if (inv.payee !== payTo) problems.push('payee');
  if (inv.expiry !== maxTimeoutSeconds) problems.push('expiry');
  if (inv.timestamp > now + skew) problems.push('created in the future');
  if (now > inv.timestamp + inv.expiry) problems.push('expired');
  if (problems.length) throw new InvoiceError(`Invoice failed checks: ${problems.join(', ')}`);
  return inv;
}

export function lnbtcRequirement({ network, amountMsat, payTo, invoice, requestHash, server, metadata = [], maxTimeoutSeconds }) {
  return {
    scheme: 'exact',
    network,
    amount: String(amountMsat),
    asset: 'BTC',
    payTo,
    maxTimeoutSeconds,
    extra: {
      assetTransferMethod: 'bolt11',
      paymentFlow: 'upfront',
      requestHash,
      requestBindingProfile: 'mcp:1',
      requestBindingParams: { server, metadata },
      invoice,
    },
  };
}

function fail(errorReason, network) {
  return { success: false, errorReason, transaction: '', network: network ?? '' };
}

/**
 * Settles an lnbtc payment the way the spec's facilitator does, locally: every
 * check in order, then an atomic claim of network:payment_hash. No access to
 * the receiver's node is needed; the preimage is the proof.
 *
 * @param {{ requirements: object, payload: object, now: number, skew?: number, claim: (key: string) => Promise<boolean> }} options
 */
export async function settleLnbtc({ requirements: req, payload: pp, now, skew = 60, claim }) {
  const acc = pp?.accepted;
  if (!acc || typeof acc !== 'object') return fail('invalid_exact_lnbtc_request_binding', req?.network);
  // 1. Core fields match
  if (acc.scheme !== req.scheme || req.scheme !== 'exact') return fail('unsupported_scheme', req.network);
  if (acc.network !== req.network) return fail('network_mismatch', req.network);
  // 2. Supported values
  if (!LNBTC_CURRENCY[req.network]) return fail('unsupported_network', req.network);
  if (acc.asset !== 'BTC' || req.asset !== 'BTC') return fail('invalid_exact_lnbtc_asset', req.network);
  if (!POSITIVE_INT.test(req.amount ?? '') || !POSITIVE_INT.test(acc.amount ?? '')) return fail('invalid_exact_lnbtc_amount', req.network);
  if (acc.amount !== req.amount) return fail('invalid_exact_lnbtc_amount_mismatch', req.network);
  if (!PUBKEY.test(req.payTo ?? '')) return fail('invalid_exact_lnbtc_pay_to_malformed', req.network);
  if (acc.payTo !== req.payTo) return fail('invalid_exact_lnbtc_pay_to_mismatch', req.network);
  if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) return fail('invalid_exact_lnbtc_max_timeout', req.network);
  if (acc.maxTimeoutSeconds !== req.maxTimeoutSeconds) return fail('invalid_exact_lnbtc_max_timeout_mismatch', req.network);
  // 3. Extra fields
  const ra = req.extra ?? {};
  const aa = acc.extra ?? {};
  if ((ra.assetTransferMethod ?? 'bolt11') !== 'bolt11' || (aa.assetTransferMethod ?? 'bolt11') !== 'bolt11') return fail('invalid_exact_lnbtc_asset_transfer_method', req.network);
  if (ra.paymentFlow !== 'upfront' || aa.paymentFlow !== 'upfront') return fail('invalid_exact_lnbtc_payment_flow', req.network);
  const bindingOk = (e) => HEX64.test(e.requestHash ?? '') && e.requestBindingProfile === 'mcp:1'
    && e.requestBindingParams && typeof e.requestBindingParams.server === 'string' && Array.isArray(e.requestBindingParams.metadata)
    && Object.keys(e.requestBindingParams).length === 2;
  if (!bindingOk(ra) || !bindingOk(aa)) return fail('invalid_exact_lnbtc_request_binding', req.network);
  if (aa.requestHash !== ra.requestHash || aa.requestBindingProfile !== ra.requestBindingProfile
    || jcs(aa.requestBindingParams) !== jcs(ra.requestBindingParams)) return fail('invalid_exact_lnbtc_request_mismatch', req.network);
  for (const [k, v] of Object.entries(ra)) {
    if (['invoice', 'requestHash', 'requestBindingProfile', 'requestBindingParams'].includes(k)) continue;
    if (jcs(v) !== jcs(aa[k])) return fail('invalid_exact_lnbtc_extra_mismatch', req.network);
  }
  // 4. Invoices present; settle against the accepted one
  if (!ra.invoice || !aa.invoice) return fail('invalid_exact_lnbtc_invoice_missing', req.network);
  // 5. Strict decode and binding checks
  let inv;
  try {
    inv = decodeInvoice(aa.invoice);
  } catch {
    return fail('invalid_exact_lnbtc_invoice_decode_failed', req.network);
  }
  if (inv.amountMsat === null) return fail('invalid_exact_lnbtc_invoice_decode_failed', req.network);
  if (inv.descriptionHashes.length !== 1 || inv.descriptions.length) return fail('invalid_exact_lnbtc_invoice_description', req.network);
  if (inv.descriptionHash !== ra.requestHash) return fail('invalid_exact_lnbtc_invoice_request_mismatch', req.network);
  if (inv.payee !== req.payTo) return fail('invalid_exact_lnbtc_invoice_payee_mismatch', req.network);
  if (inv.currency !== LNBTC_CURRENCY[req.network]) return fail('invalid_exact_lnbtc_invoice_currency_mismatch', req.network);
  if (inv.amountMsat !== BigInt(req.amount)) return fail('invalid_exact_lnbtc_invoice_amount_mismatch', req.network);
  if (inv.expiry !== req.maxTimeoutSeconds) return fail('invalid_exact_lnbtc_invoice_expiry_mismatch', req.network);
  if (inv.timestamp > now + skew) return fail('invalid_exact_lnbtc_invoice_created_in_future', req.network);
  // 6. Preimage
  const preimage = pp.payload?.preimage;
  if (preimage === undefined) return fail('invalid_exact_lnbtc_preimage_missing', req.network);
  if (typeof preimage !== 'string' || !/^[0-9a-f]*$/.test(preimage)) return fail('invalid_exact_lnbtc_preimage_malformed', req.network);
  if (preimage.length !== 64) return fail('invalid_exact_lnbtc_preimage_length', req.network);
  if (sha256(Buffer.from(preimage, 'hex')).toString('hex') !== inv.paymentHash) return fail('invalid_exact_lnbtc_preimage_hash_mismatch', req.network);
  // 7. Paid-but-expired grace window
  if (now > inv.timestamp + inv.expiry + skew) return fail('invalid_exact_lnbtc_invoice_expired', req.network);
  // Single use
  if (!(await claim(`${req.network}:${inv.paymentHash}`))) return fail('duplicate_settlement', req.network);
  return { success: true, transaction: inv.paymentHash, network: req.network };
}

// --- EVM: exact with EIP-3009 (USDC) ---

export const USDC = {
  'eip155:84532': { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', transferMethod: 'eip3009', name: 'USDC', version: '2', decimals: 6, symbol: 'USDC', label: 'USDC on Base Sepolia (test network)' },
};

export const transferMethodOf = (requirement) => requirement?.extra?.assetTransferMethod ?? 'eip3009';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const strip0x = (h) => String(h).replace(/^0x/i, '');
const word = (hex) => Buffer.from(strip0x(hex).padStart(64, '0'), 'hex');
const uintWord = (n) => bigIntToBytes(BigInt(n));
const DOMAIN_TYPEHASH = keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
export const TRANSFER_TYPEHASH = keccak256('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');

/** EIP-55 checksummed address. */
export function checksumAddress(address) {
  const lower = strip0x(address).toLowerCase();
  const hash = keccak256(lower).toString('hex');
  return `0x${[...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

export function addressFromPrivateKey(privateKey) {
  return checksumAddress(keccak256(uncompressed(publicKeyPoint(privateKey))).subarray(12).toString('hex'));
}

/** EIP-712 digest of an EIP-3009 TransferWithAuthorization. */
export function transferDigest({ name, version, chainId, verifyingContract }, a) {
  const domain = keccak256(Buffer.concat([DOMAIN_TYPEHASH, keccak256(name), keccak256(version), uintWord(chainId), word(verifyingContract)]));
  const struct = keccak256(Buffer.concat([TRANSFER_TYPEHASH, word(a.from), word(a.to), uintWord(a.value), uintWord(a.validAfter), uintWord(a.validBefore), word(a.nonce)]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}

const chainIdOf = (network) => BigInt(network.split(':')[1]);
const encodeSignature = ({ r, s, recid }) => `0x${Buffer.concat([bigIntToBytes(r), bigIntToBytes(s), Buffer.from([27 + recid])]).toString('hex')}`;

/** The address that signed `digest` with a 65-byte signature, or null. */
function recoverAddress(digest, signature) {
  const sig = Buffer.from(strip0x(signature), 'hex');
  if (sig.length !== 65) return null;
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const point = recover(digest, bytesToBigInt(sig.subarray(0, 32)), bytesToBigInt(sig.subarray(32, 64)), v);
  return point ? checksumAddress(keccak256(uncompressed(point)).subarray(12).toString('hex')) : null;
}

const eip3009Domain = (requirement) => ({ name: requirement.extra.name, version: requirement.extra.version, chainId: chainIdOf(requirement.network), verifyingContract: requirement.asset });

/** Signs an authorization that pays `requirement` (client side: the demo payer and tests). */
export function signTransferAuthorization({ privateKey, requirement, now, nonce }) {
  const authorization = {
    from: addressFromPrivateKey(privateKey),
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: String(now - 60),
    validBefore: String(now + requirement.maxTimeoutSeconds),
    nonce: nonce ?? `0x${randomBytes(32).toString('hex')}`,
  };
  return { signature: encodeSignature(sign(transferDigest(eip3009Domain(requirement), authorization), privateKey)), authorization };
}

/** Recovers the signer of an EIP-3009 authorization signature, or null. */
export function recoverTransferSigner(requirement, { signature, authorization }) {
  return recoverAddress(transferDigest(eip3009Domain(requirement), authorization), signature);
}

// --- EVM: exact with Permit2 (USDT, and any ERC-20 without EIP-3009) ---

/** Uniswap's canonical Permit2, and x402's proxy, which only pays the address in the signed witness. Same on every chain. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
const PERMIT2_DOMAIN_TYPEHASH = keccak256('EIP712Domain(string name,uint256 chainId,address verifyingContract)');
export const TOKEN_PERMISSIONS_TYPEHASH = keccak256('TokenPermissions(address token,uint256 amount)');
const WITNESS_TYPEHASH = keccak256('Witness(address to,uint256 validAfter)');
export const PERMIT_WITNESS_TYPEHASH = keccak256('PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)');

/** EIP-712 digest of a Permit2 PermitWitnessTransferFrom carrying the x402 `exact` witness. */
export function permit2Digest(chainId, a) {
  const domain = keccak256(Buffer.concat([PERMIT2_DOMAIN_TYPEHASH, keccak256('Permit2'), uintWord(chainId), word(PERMIT2_ADDRESS)]));
  const permitted = keccak256(Buffer.concat([TOKEN_PERMISSIONS_TYPEHASH, word(a.permitted.token), uintWord(a.permitted.amount)]));
  const witness = keccak256(Buffer.concat([WITNESS_TYPEHASH, word(a.witness.to), uintWord(a.witness.validAfter)]));
  const struct = keccak256(Buffer.concat([PERMIT_WITNESS_TYPEHASH, permitted, word(a.spender), uintWord(a.nonce), uintWord(a.deadline), witness]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}

/**
 * Signs a Permit2 transfer that pays `requirement` through x402's proxy, as the
 * reference client does: validAfter 0, deadline now + maxTimeoutSeconds and a
 * random 256-bit nonce. On a real network the payer must first approve Permit2
 * for the token, once.
 */
export function signPermit2Authorization({ privateKey, requirement, now, nonce }) {
  const permit2Authorization = {
    from: addressFromPrivateKey(privateKey),
    permitted: { token: checksumAddress(requirement.asset), amount: requirement.amount },
    spender: X402_EXACT_PERMIT2_PROXY,
    nonce: nonce ?? BigInt(`0x${randomBytes(32).toString('hex')}`).toString(),
    deadline: String(now + requirement.maxTimeoutSeconds),
    witness: { to: checksumAddress(requirement.payTo), validAfter: '0' },
  };
  return { signature: encodeSignature(sign(permit2Digest(chainIdOf(requirement.network), permit2Authorization), privateKey)), permit2Authorization };
}

/** Recovers the signer of a Permit2 authorization signature, or null. */
export function recoverPermit2Signer(requirement, { signature, permit2Authorization }) {
  return recoverAddress(permit2Digest(chainIdOf(requirement.network), permit2Authorization), signature);
}

/** Signs whichever EVM transfer method the requirement asks for. */
export function signEvmPayment({ privateKey, requirement, now }) {
  return transferMethodOf(requirement) === 'permit2'
    ? signPermit2Authorization({ privateKey, requirement, now })
    : signTransferAuthorization({ privateKey, requirement, now });
}

/** PaymentRequirements for an EVM token: `token` is { asset, transferMethod: 'eip3009' | 'permit2', name?, version? }. */
export function evmRequirement({ token, network, amount, payTo, maxTimeoutSeconds }) {
  const extra = token.transferMethod === 'permit2'
    ? { assetTransferMethod: 'permit2' }
    : { assetTransferMethod: 'eip3009', name: token.name, version: token.version };
  return { scheme: 'exact', network, amount: String(amount), asset: token.asset, payTo, maxTimeoutSeconds, extra };
}

export function usdcRequirement({ network, amount, payTo, maxTimeoutSeconds }) {
  const token = USDC[network];
  if (!token) throw new Error(`No USDC settings for ${network}`);
  return evmRequirement({ token, network, amount, payTo, maxTimeoutSeconds });
}

/** Facilitator over HTTP: POST /verify then /settle (x402 v2, section 7). */
export function remoteFacilitator(url, { fetchImpl = globalThis.fetch } = {}) {
  const call = async (path, paymentPayload, paymentRequirements) => {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body.isValid === undefined && body.success === undefined) throw new Error(`Facilitator ${path} returned HTTP ${res.status}`);
    return body;
  };
  return {
    simulated: false,
    verify: (payload, requirements) => call('/verify', payload, requirements),
    settle: (payload, requirements) => call('/settle', payload, requirements),
  };
}

/**
 * A stand-in facilitator for development: checks the EIP-712 signature, payee,
 * token, amount, time window and nonce locally, and returns a simulated
 * transaction. No funds move. It can't see a chain, so it assumes the payer
 * has the balance and, for Permit2, has approved Permit2 for the token.
 * Error codes follow the x402 specification and its reference facilitator.
 */
export function simulatedEvmFacilitator({ claim, now = () => Math.floor(Date.now() / 1000) }) {
  const invalid = (invalidReason) => ({ isValid: false, invalidReason });
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const eip3009 = (payload, req) => {
    const a = payload.authorization;
    if (!a || typeof payload.signature !== 'string' || ![a.from, a.to].every((x) => ADDRESS.test(x ?? ''))
      || ![a.value, a.validAfter, a.validBefore].every((x) => UINT.test(x ?? '')) || !BYTES32.test(a.nonce ?? '')) return invalid('invalid_payload');
    const signer = recoverTransferSigner(req, payload);
    if (!signer || !same(signer, a.from)) return invalid('invalid_exact_evm_payload_signature');
    if (!same(a.to, req.payTo)) return invalid('invalid_exact_evm_payload_recipient_mismatch');
    if (a.value !== String(req.amount)) return invalid('invalid_exact_evm_payload_authorization_value_mismatch');
    const t = now();
    if (t < Number(a.validAfter)) return invalid('invalid_exact_evm_payload_authorization_valid_after');
    if (t >= Number(a.validBefore)) return invalid('invalid_exact_evm_payload_authorization_valid_before');
    return { isValid: true, payer: signer };
  };
  const permit2 = (payload, req) => {
    const a = payload.permit2Authorization;
    if (!a?.permitted || !a.witness || typeof payload.signature !== 'string'
      || ![a.from, a.spender, a.permitted.token, a.witness.to].every((x) => ADDRESS.test(x ?? ''))
      || ![a.permitted.amount, a.nonce, a.deadline, a.witness.validAfter].every((x) => UINT.test(x ?? ''))) return invalid('invalid_payload');
    const signer = recoverPermit2Signer(req, payload);
    if (!signer || !same(signer, a.from)) return invalid('invalid_permit2_signature');
    if (!same(a.spender, X402_EXACT_PERMIT2_PROXY)) return invalid('invalid_permit2_spender');
    if (!same(a.witness.to, req.payTo)) return invalid('invalid_permit2_recipient_mismatch');
    if (!same(a.permitted.token, req.asset)) return invalid('permit2_token_mismatch');
    if (a.permitted.amount !== String(req.amount)) return invalid('permit2_amount_mismatch');
    const t = now();
    if (t > Number(a.deadline)) return invalid('permit2_deadline_expired');
    if (t < Number(a.witness.validAfter)) return invalid('permit2_not_yet_valid');
    return { isValid: true, payer: signer };
  };
  const check = (pp, req) => {
    if (!pp?.payload || typeof pp.payload !== 'object') return invalid('invalid_payload');
    if (pp.accepted?.network !== req.network) return invalid('invalid_network');
    return transferMethodOf(req) === 'permit2' ? permit2(pp.payload, req) : eip3009(pp.payload, req);
  };
  // Permit2 nonces belong to the payer; EIP-3009 nonces are random 32-byte values
  const nonceKey = (pp, req) => (transferMethodOf(req) === 'permit2'
    ? `${req.network}:permit2:${pp.payload.permit2Authorization.from.toLowerCase()}:${pp.payload.permit2Authorization.nonce}`
    : `${req.network}:${pp.payload.authorization.nonce.toLowerCase()}`);
  return {
    simulated: true,
    verify: async (pp, req) => check(pp, req),
    settle: async (pp, req) => {
      const v = check(pp, req);
      if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: '', network: req.network };
      if (!(await claim(nonceKey(pp, req)))) {
        return { success: false, errorReason: 'duplicate_settlement', transaction: '', network: req.network };
      }
      const tx = `0x${keccak256(Buffer.from(jcs(pp.payload), 'utf8')).toString('hex')}`;
      return { success: true, transaction: tx, network: req.network, payer: v.payer, simulated: true };
    },
  };
}

export function paymentRequired({ resource, accepts, error = 'Payment required to place this order' }) {
  return { x402Version: X402_VERSION, error, resource, accepts };
}

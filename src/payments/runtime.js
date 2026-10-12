import { resolve } from 'node:path';
import { mcpUrl } from '../lib/project.js';
import { lndNode, nwcNode, simulatedNode } from './lightning.js';
import { parseRate } from './quote.js';
import { fileStore } from './store.js';
import { LNBTC, USDC, checksumAddress, remoteFacilitator, simulatedEvmFacilitator } from './x402.js';

/**
 * Turns the `payments` block of gentifi.json into working rails. Example:
 *
 *   "payments": {
 *     "rates": { "BTC": "80000", "USD": "1.27" },
 *     "lightning": { "network": "testnet", "node": "simulated" },
 *     "usdc": { "network": "eip155:84532", "payTo": "0x…", "facilitator": "simulated" },
 *     "usdt": { "network": "eip155:84532", "asset": "0x…", "payTo": "0x…", "facilitator": "simulated" }
 *   }
 *
 * USDT has no EIP-3009, so it is paid with Permit2 ("transferMethod": "permit2",
 * the default). There's no official USDT on test networks, so "asset" names a
 * test token standing in for it.
 *
 * A real Lightning node: "node": { "type": "lnd", "url": "https://127.0.0.1:8080",
 * "macaroonEnv": "GENTIFI_LND_MACAROON", "tlsCert": "/path/to/tls.cert" } with "payTo"
 * set to the node's public key. Or a wallet over Nostr Wallet Connect, such as
 * Alby Hub: "node": { "type": "nwc", "uriEnv": "GENTIFI_NWC_URI" }, again with
 * "payTo" set to the wallet's node key. Secrets stay in environment variables.
 */

export const DEFAULT_TIMEOUTS = { lightning: 600, usdc: 300, usdt: 300 };

/** EVM test networks the prototype accepts for USDT. */
export const EVM_TEST_NETWORKS = { 'eip155:84532': 'Base Sepolia', 'eip155:11155111': 'Ethereum Sepolia', 'eip155:421614': 'Arbitrum Sepolia' };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Problems with a payments block, as plain sentences (empty when it's usable). */
export function paymentProblems(payments) {
  const p = [];
  if (!payments || typeof payments !== 'object') return ['payments must be an object'];
  const { lightning, usdc, usdt, rates = {} } = payments;
  if (!lightning && !usdc && !usdt) p.push('payments needs a lightning, usdc or usdt rail');
  if (lightning) {
    if (!LNBTC[lightning.network]) p.push(`payments.lightning.network must be one of: ${Object.keys(LNBTC).join(', ')}`);
    try { parseRate(rates.BTC, 'BTC'); } catch (e) { p.push(e.message); }
    const node = lightning.node;
    if (node !== 'simulated' && !['lnd', 'nwc'].includes(node?.type)) p.push('payments.lightning.node must be "simulated", { "type": "lnd", … } or { "type": "nwc", … }');
    if (node?.type === 'lnd') {
      if (!/^https?:\/\//.test(node.url ?? '')) p.push('payments.lightning.node.url must be the LND REST address');
      if (!node.macaroonEnv) p.push('payments.lightning.node.macaroonEnv must name the environment variable holding an invoice macaroon (hex)');
      if (!/^0[23][0-9a-f]{64}$/.test(lightning.payTo ?? '')) p.push('payments.lightning.payTo must be the node\'s public key (66 hex characters)');
    }
    if (node?.type === 'nwc') {
      if (!node.uriEnv) p.push('payments.lightning.node.uriEnv must name the environment variable holding the wallet\'s Nostr Wallet Connect string');
      if (!/^0[23][0-9a-f]{64}$/.test(lightning.payTo ?? '')) p.push('payments.lightning.payTo must be the wallet\'s node public key (66 hex characters)');
    }
  }
  if (usdc) {
    if (!USDC[usdc.network]) p.push(`payments.usdc.network must be one of: ${Object.keys(USDC).join(', ')} (test networks only in this prototype)`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(usdc.payTo ?? '')) p.push('payments.usdc.payTo must be the business\'s own address (0x followed by 40 hex characters)');
    if (usdc.facilitator !== 'simulated' && !/^https:\/\//.test(usdc.facilitator ?? '')) p.push('payments.usdc.facilitator must be "simulated" or an https facilitator URL');
  }
  if (usdt) {
    if (!EVM_TEST_NETWORKS[usdt.network]) p.push(`payments.usdt.network must be one of: ${Object.keys(EVM_TEST_NETWORKS).join(', ')} (test networks only in this prototype)`);
    if (!ADDRESS.test(usdt.asset ?? '')) p.push('payments.usdt.asset must be the token\'s contract address on that network. There is no official USDT on test networks, so use a test token');
    if (!ADDRESS.test(usdt.payTo ?? '')) p.push('payments.usdt.payTo must be the business\'s own address (0x followed by 40 hex characters)');
    if (usdt.facilitator !== 'simulated' && !/^https:\/\//.test(usdt.facilitator ?? '')) p.push('payments.usdt.facilitator must be "simulated" or an https facilitator URL');
    const method = usdt.transferMethod ?? 'permit2';
    if (!['permit2', 'eip3009'].includes(method)) p.push('payments.usdt.transferMethod must be "permit2" (USDT) or "eip3009" (only for USDT0 deployments that support it)');
    if (method === 'eip3009' && !(usdt.name && usdt.version)) p.push('payments.usdt.name and payments.usdt.version (the token\'s EIP-712 domain) are needed for "eip3009"');
    if (usdt.decimals !== undefined && !(Number.isInteger(usdt.decimals) && usdt.decimals >= 0 && usdt.decimals <= 36)) p.push('payments.usdt.decimals must be a whole number (USDT uses 6)');
  }
  if (usdc || usdt) {
    try { parseRate(rates.USD, 'USD'); } catch (e) { p.push(e.message); }
  }
  return p;
}

/**
 * @param {object} project gentifi.json
 * @param {{ projectDir?: string, store?: object, simulate?: boolean, env?: object, now?: () => number }} options
 *   simulate: use a simulated node and facilitator whatever the config says
 */
export async function createPayments(project, { projectDir = '.', store, simulate = false, env = process.env, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const config = project.payments;
  if (!config) return null;
  const problems = paymentProblems(config);
  if (problems.length) throw new Error(`Payments are not set up correctly:\n  - ${problems.join('\n  - ')}`);

  const st = store ?? await fileStore(resolve(projectDir, config.dataDir ?? '.gentifi'));
  const secret = env.GENTIFI_STATE_SECRET ? Buffer.from(env.GENTIFI_STATE_SECRET, 'hex') : await st.secret('state-secret');

  let lightning = null;
  if (config.lightning) {
    const { network, node: nodeConfig, maxTimeoutSeconds = DEFAULT_TIMEOUTS.lightning } = config.lightning;
    let node;
    if (simulate || nodeConfig === 'simulated') {
      node = simulatedNode({ network, privateKey: await st.secret('simulated-lightning-key'), now });
    } else if (nodeConfig.type === 'nwc') {
      const uri = env[nodeConfig.uriEnv];
      if (!uri) throw new Error(`Set ${nodeConfig.uriEnv} to the wallet's Nostr Wallet Connect string`);
      node = nwcNode({ uri, network, payTo: config.lightning.payTo });
    } else {
      const macaroon = env[nodeConfig.macaroonEnv];
      if (!macaroon) throw new Error(`Set ${nodeConfig.macaroonEnv} to the LND invoice macaroon (hex)`);
      node = await lndNode({ url: nodeConfig.url, macaroon, tlsCert: nodeConfig.tlsCert, network, payTo: config.lightning.payTo });
    }
    lightning = { node, network: node.network, payTo: node.payTo, maxTimeoutSeconds, simulated: node.simulated };
  }

  // Dollar stablecoins on EVM chains, settled by a facilitator straight to the business's address
  const coin = (rail, token) => {
    const { network, payTo, facilitator: url, maxTimeoutSeconds = DEFAULT_TIMEOUTS[rail] } = config[rail];
    const facilitator = simulate || url === 'simulated' ? simulatedEvmFacilitator({ claim: st.claim, now }) : remoteFacilitator(url);
    return { rail, symbol: token.symbol, network, payTo, facilitator, maxTimeoutSeconds, token, simulated: facilitator.simulated };
  };
  const usdc = config.usdc ? coin('usdc', USDC[config.usdc.network]) : null;
  const usdt = config.usdt ? coin('usdt', {
    asset: checksumAddress(config.usdt.asset),
    transferMethod: config.usdt.transferMethod ?? 'permit2',
    name: config.usdt.name,
    version: config.usdt.version,
    decimals: config.usdt.decimals ?? 6,
    symbol: 'USDT',
    label: `USDT test token on ${EVM_TEST_NETWORKS[config.usdt.network]} (test network)`,
  }) : null;
  const coins = [usdc, usdt].filter(Boolean);

  return {
    lightning,
    usdc,
    usdt,
    coins,
    rates: config.rates ?? {},
    store: st,
    secret,
    server: mcpUrl(project),
    orderWebhook: config.orderWebhook,
    now,
    payees: payeesOf({ lightning, coins }),
  };
}

/** What the business publishes so agents can check a payment request pays the right party. */
export function payeesOf({ lightning, coins = [] }) {
  return [
    ...(lightning ? [{ rail: 'lightning', network: lightning.network, asset: 'BTC', payTo: lightning.payTo }] : []),
    ...coins.map((c) => ({ rail: c.rail, network: c.network, asset: c.token.asset, symbol: c.symbol, decimals: c.token.decimals, payTo: c.payTo })),
  ];
}

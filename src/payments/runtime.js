import { resolve } from 'node:path';
import { mcpUrl } from '../lib/project.js';
import { lndNode, simulatedNode } from './lightning.js';
import { parseRate } from './quote.js';
import { fileStore } from './store.js';
import { LNBTC, USDC, remoteFacilitator, simulatedEvmFacilitator } from './x402.js';

/**
 * Turns the `payments` block of gentifi.json into working rails. Example:
 *
 *   "payments": {
 *     "rates": { "BTC": "80000", "USD": "1.27" },
 *     "lightning": { "network": "testnet", "node": "simulated" },
 *     "usdc": { "network": "eip155:84532", "payTo": "0x…", "facilitator": "simulated" }
 *   }
 *
 * A real Lightning node: "node": { "type": "lnd", "url": "https://127.0.0.1:8080",
 * "macaroonEnv": "GENTIFI_LND_MACAROON", "tlsCert": "/path/to/tls.cert" } with "payTo"
 * set to the node's public key. Secrets stay in environment variables.
 */

export const DEFAULT_TIMEOUTS = { lightning: 600, usdc: 300 };

/** Problems with a payments block, as plain sentences (empty when it's usable). */
export function paymentProblems(payments) {
  const p = [];
  if (!payments || typeof payments !== 'object') return ['payments must be an object'];
  const { lightning, usdc, rates = {} } = payments;
  if (!lightning && !usdc) p.push('payments needs a lightning or usdc rail');
  if (lightning) {
    if (!LNBTC[lightning.network]) p.push(`payments.lightning.network must be one of: ${Object.keys(LNBTC).join(', ')}`);
    try { parseRate(rates.BTC, 'BTC'); } catch (e) { p.push(e.message); }
    const node = lightning.node;
    if (node !== 'simulated' && !(node && node.type === 'lnd')) p.push('payments.lightning.node must be "simulated" or { "type": "lnd", … }');
    if (node?.type === 'lnd') {
      if (!/^https?:\/\//.test(node.url ?? '')) p.push('payments.lightning.node.url must be the LND REST address');
      if (!node.macaroonEnv) p.push('payments.lightning.node.macaroonEnv must name the environment variable holding an invoice macaroon (hex)');
      if (!/^0[23][0-9a-f]{64}$/.test(lightning.payTo ?? '')) p.push('payments.lightning.payTo must be the node\'s public key (66 hex characters)');
    }
  }
  if (usdc) {
    if (!USDC[usdc.network]) p.push(`payments.usdc.network must be one of: ${Object.keys(USDC).join(', ')} (test networks only in this prototype)`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(usdc.payTo ?? '')) p.push('payments.usdc.payTo must be the business\'s own address (0x followed by 40 hex characters)');
    if (usdc.facilitator !== 'simulated' && !/^https:\/\//.test(usdc.facilitator ?? '')) p.push('payments.usdc.facilitator must be "simulated" or an https facilitator URL');
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
    } else {
      const macaroon = env[nodeConfig.macaroonEnv];
      if (!macaroon) throw new Error(`Set ${nodeConfig.macaroonEnv} to the LND invoice macaroon (hex)`);
      node = await lndNode({ url: nodeConfig.url, macaroon, tlsCert: nodeConfig.tlsCert, network, payTo: config.lightning.payTo });
    }
    lightning = { node, network: node.network, payTo: node.payTo, maxTimeoutSeconds, simulated: node.simulated };
  }

  let usdc = null;
  if (config.usdc) {
    const { network, payTo, facilitator: url, maxTimeoutSeconds = DEFAULT_TIMEOUTS.usdc } = config.usdc;
    const facilitator = simulate || url === 'simulated' ? simulatedEvmFacilitator({ claim: st.claim, now }) : remoteFacilitator(url);
    usdc = { network, payTo, facilitator, maxTimeoutSeconds, token: USDC[network], simulated: facilitator.simulated };
  }

  return {
    lightning,
    usdc,
    rates: config.rates ?? {},
    store: st,
    secret,
    server: mcpUrl(project),
    orderWebhook: config.orderWebhook,
    now,
    payees: payeesOf({ lightning, usdc }),
  };
}

/** What the business publishes so agents can check a payment request pays the right party. */
export function payeesOf({ lightning, usdc }) {
  return [
    ...(lightning ? [{ rail: 'lightning', network: lightning.network, asset: 'BTC', payTo: lightning.payTo }] : []),
    ...(usdc ? [{ rail: 'usdc', network: usdc.network, asset: usdc.token.asset, payTo: usdc.payTo }] : []),
  ];
}

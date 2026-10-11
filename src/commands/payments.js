import { dirname } from 'node:path';
import { ProjectError, loadProject, projectPath, saveProject } from '../lib/project.js';
import { createPayments, paymentProblems } from '../payments/runtime.js';
import { randomPrivateKey } from '../payments/lightning.js';
import { addressFromPrivateKey } from '../payments/x402.js';
import { formatSats, formatToken, penceToMsat, penceToTokenUnits } from '../payments/quote.js';

const randomAddress = () => addressFromPrivateKey(randomPrivateKey());

/**
 * A fully simulated setup for trying pay_order: no node, no keys, no real
 * money. There's no official USDT on test networks, so the demo's USDT is a
 * made-up token address that only the simulated facilitator ever sees.
 */
export function demoPayments() {
  return {
    rates: { BTC: '80000', USD: '1.27' },
    lightning: { network: 'testnet', node: 'simulated' },
    usdc: { network: 'eip155:84532', payTo: randomAddress(), facilitator: 'simulated' },
    usdt: { network: 'eip155:84532', asset: randomAddress(), payTo: randomAddress(), facilitator: 'simulated' },
  };
}

export default {
  summary: 'Show or set up agent payments (Lightning, USDC and USDT, prototype)',
  usage: '[--demo] [--project <file>]',
  options: {
    demo: { type: 'boolean', description: 'Add a simulated setup on test networks, to try pay_order with no real money' },
    force: { type: 'boolean', description: 'With --demo, replace an existing payments block' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err }) {
    const path = projectPath(values);
    let project;
    try {
      project = await loadProject(path);
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    if (values.demo) {
      if (project.payments && !values.force) {
        err('This project already has payments set up. Use --force to replace them with the simulated demo.');
        return 1;
      }
      project.payments = demoPayments();
      await saveProject(path, project);
      out([
        'Added a simulated payments setup:',
        '  Lightning: a simulated node on testnet. No real money moves.',
        '  USDC: Base Sepolia terms, settled by a simulated facilitator. No real money moves.',
        '  USDT: Permit2 terms for a stand-in token on Base Sepolia (there is no official USDT on test networks),',
        '        settled by a simulated facilitator. No real money moves.',
        '  Rates: £1 = $1.27 and 1 BTC = £80,000, for testing only. Change payments.rates for real quotes.',
        '',
        'Try it: gentifi serve, then node examples/agent-pay.mjs (in the toolkit repository).',
      ].join('\n'));
      return 0;
    }
    if (!project.payments) {
      out('No payments set up. Agents can still prepare orders that the customer confirms on your own checkout.\nTo try paying through the agent with no real money: gentifi payments --demo');
      return 0;
    }
    const problems = paymentProblems(project.payments);
    if (problems.length) {
      err(['Payments are not set up correctly:', ...problems.map((p) => `  - ${p}`)].join('\n'));
      return 1;
    }
    const payments = await createPayments(project, { projectDir: dirname(path) });
    const sample = 1000; // £10.00, in pence
    out([
      'Payments (pay_order):',
      ...(payments.lightning ? [`  Lightning  ${payments.lightning.simulated ? 'simulated node' : 'LND node'} on ${payments.lightning.network}`, `             pays ${payments.lightning.payTo}`, `             £10.00 is ${formatSats(penceToMsat(sample, payments.rates.BTC))}`] : []),
      ...payments.coins.flatMap((c) => [
        `  ${c.symbol.padEnd(11)}${c.token.label}, ${c.token.transferMethod === 'permit2' ? 'Permit2, ' : ''}${c.simulated ? 'simulated settlement' : 'facilitator settlement'}`,
        `             pays ${c.payTo}`,
        `             £10.00 is ${formatToken(penceToTokenUnits(sample, payments.rates.USD, c.token.decimals), c.symbol, c.token.decimals)}`,
      ]),
      '',
      'Customers confirm every order in their own app before any payment request is made.',
    ].join('\n'));
    return 0;
  },
};

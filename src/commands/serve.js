import { dirname } from 'node:path';
import { createHttpServer } from '../mcp/http.js';
import { createProtocol } from '../mcp/protocol.js';
import { serveStdio } from '../mcp/stdio.js';
import { businessTools } from '../mcp/tools.js';
import { generateOutputs, serverInfo, serverInstructions } from '../lib/outputs.js';
import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { VERSION } from '../lib/version.js';
import { createPayments } from '../payments/runtime.js';
import { simulatedNwcWallet } from '../payments/nwc.js';
import { startRelay } from '../payments/relay.js';
import { payOrderTool } from '../payments/tool.js';

/** Everything the server needs for one business, in memory. `payments` comes from createPayments. */
export function businessServer(project, { log = () => {}, payments = null } = {}) {
  const tools = [...businessTools(project), ...(payments ? [payOrderTool(project, payments)] : [])];
  const protocol = createProtocol({
    serverInfo: serverInfo(project, VERSION),
    instructions: serverInstructions(project),
    tools,
    log,
  });
  return { protocol, files: generateOutputs(project, VERSION, { payees: payments?.payees ?? [] }) };
}

/** A local-only route that plays the Lightning network for a simulated node. */
export function simulatedLightningRoutes(payments) {
  if (!payments?.lightning?.simulated) return {};
  return {
    '/dev/simulated-lightning/pay': async ({ invoice }) => payments.lightning.node.pay(invoice),
  };
}

function describePayments(payments) {
  const lines = [];
  const kinds = { simulated: 'simulated node (no real money)', lnd: 'LND', nwc: 'wallet over Nostr Wallet Connect' };
  if (payments.lightning) lines.push(`  Lightning       ${kinds[payments.lightning.node.kind] ?? 'node'} on ${payments.lightning.network}, paying ${payments.lightning.payTo.slice(0, 16)}…`);
  for (const c of payments.coins) {
    const method = c.token.transferMethod === 'permit2' ? 'paid with Permit2, ' : '';
    lines.push(`  ${c.symbol.padEnd(16)}${c.token.label}, ${method}${c.simulated ? 'simulated settlement (no real money)' : 'settled by the facilitator'}, paying ${c.payTo}`);
  }
  return lines;
}

export default {
  summary: 'Run the MCP connector, over HTTP or stdio',
  usage: '[--port <n>] [--host <address>] [--stdio] [--project <file>]',
  options: {
    port: { type: 'string', description: 'HTTP port (default 8787)' },
    host: { type: 'string', description: 'Address to listen on (default 127.0.0.1; use 0.0.0.0 behind a proxy)' },
    stdio: { type: 'boolean', description: 'Speak MCP over stdin and stdout, for local agent apps' },
    'allow-origin': { type: 'string', multiple: true, description: 'Extra browser origin allowed to call the connector (repeatable)' },
    'simulate-payments': { type: 'boolean', description: 'Use a simulated Lightning node and facilitator: no real money moves' },
    project: { type: 'string', description: 'Project file (default ./gentifi.json)' },
  },
  async run(values, { out, err }) {
    let project;
    try {
      project = await loadProject(projectPath(values));
    } catch (e) {
      if (e instanceof ProjectError) { err(e.message); return 1; }
      throw e;
    }
    const log = (s) => err(s);
    let payments = null;
    try {
      payments = await createPayments(project, { projectDir: dirname(projectPath(values)), simulate: values['simulate-payments'] });
    } catch (e) {
      err(e.message);
      return 1;
    }
    const { protocol, files } = businessServer(project, { log, payments });

    if (values.stdio) {
      err(`${project.business.name}: MCP over stdio (gentifi-toolkit ${VERSION})`);
      await serveStdio(protocol);
      return 0;
    }

    const port = Number(values.port ?? 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      err('--port must be a number between 0 and 65535');
      return 1;
    }
    const host = values.host ?? '127.0.0.1';
    const server = createHttpServer({ protocol, files, allowedOrigins: values['allow-origin'] ?? [], devRoutes: simulatedLightningRoutes(payments), log });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    }).catch((e) => {
      err(`Could not listen on ${host}:${port}: ${e.message}`);
      return null;
    });
    if (!server.listening) return 1;

    const shown = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;

    // With a simulated node, also run a local relay and a simulated customer wallet,
    // so the demo agent can pay over Nostr Wallet Connect with a budget.
    let nwcDemo = null;
    if (payments?.lightning?.simulated) {
      const relay = await startRelay();
      const wallet = await simulatedNwcWallet({ relayUrl: relay.url, pay: (invoice) => payments.lightning.node.pay(invoice), budgetMsat: 50000000n });
      nwcDemo = { relay, wallet };
    }
    out([
      `Serving ${project.business.name} (gentifi-toolkit ${VERSION})`,
      `  MCP connector   ${shown}/mcp`,
      `  Scan-to-add     ${shown}/`,
      `  Discovery       ${shown}/.well-known/ard.json`,
      ...(payments ? ['', 'Payments (pay_order):', ...describePayments(payments)] : []),
      ...(nwcDemo ? [
        '',
        'Simulated customer wallet, over Nostr Wallet Connect (budget 50,000 sats, no real money):',
        `  GENTIFI_PAYER_NWC='${nwcDemo.wallet.uri}'`,
      ] : []),
      '',
      'Press Ctrl+C to stop.',
    ].join('\n'));

    await new Promise((resolve) => {
      const stop = () => {
        nwcDemo?.wallet.close();
        nwcDemo?.relay.close();
        server.close(resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  },
};

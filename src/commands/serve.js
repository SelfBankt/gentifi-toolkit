import { dirname } from 'node:path';
import { createHttpServer } from '../mcp/http.js';
import { createProtocol } from '../mcp/protocol.js';
import { serveStdio } from '../mcp/stdio.js';
import { businessTools } from '../mcp/tools.js';
import { generateOutputs, serverInfo, serverInstructions } from '../lib/outputs.js';
import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { VERSION } from '../lib/version.js';
import { createPayments } from '../payments/runtime.js';
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
  if (payments.lightning) lines.push(`  Lightning       ${payments.lightning.simulated ? 'simulated node (no real money)' : 'LND'} on ${payments.lightning.network}, paying ${payments.lightning.payTo.slice(0, 16)}…`);
  if (payments.usdc) lines.push(`  USDC            ${payments.usdc.token.label}, ${payments.usdc.simulated ? 'simulated settlement (no real money)' : 'settled by the facilitator'}, paying ${payments.usdc.payTo}`);
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
    out([
      `Serving ${project.business.name} (gentifi-toolkit ${VERSION})`,
      `  MCP connector   ${shown}/mcp`,
      `  Scan-to-add     ${shown}/`,
      `  Discovery       ${shown}/.well-known/ard.json`,
      ...(payments ? ['', 'Payments (pay_order):', ...describePayments(payments)] : []),
      '',
      'Press Ctrl+C to stop.',
    ].join('\n'));

    await new Promise((resolve) => {
      const stop = () => server.close(resolve);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  },
};

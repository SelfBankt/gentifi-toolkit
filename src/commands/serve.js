import { createHttpServer } from '../mcp/http.js';
import { createProtocol } from '../mcp/protocol.js';
import { serveStdio } from '../mcp/stdio.js';
import { businessTools } from '../mcp/tools.js';
import { generateOutputs, serverInfo, serverInstructions } from '../lib/outputs.js';
import { ProjectError, loadProject, projectPath } from '../lib/project.js';
import { VERSION } from '../lib/version.js';

/** Everything the server needs for one business, in memory. */
export function businessServer(project, { log = () => {} } = {}) {
  const protocol = createProtocol({
    serverInfo: serverInfo(project, VERSION),
    instructions: serverInstructions(project),
    tools: businessTools(project),
    log,
  });
  return { protocol, files: generateOutputs(project, VERSION) };
}

export default {
  summary: 'Run the MCP connector, over HTTP or stdio',
  usage: '[--port <n>] [--host <address>] [--stdio] [--project <file>]',
  options: {
    port: { type: 'string', description: 'HTTP port (default 8787)' },
    host: { type: 'string', description: 'Address to listen on (default 127.0.0.1; use 0.0.0.0 behind a proxy)' },
    stdio: { type: 'boolean', description: 'Speak MCP over stdin and stdout, for local agent apps' },
    'allow-origin': { type: 'string', multiple: true, description: 'Extra browser origin allowed to call the connector (repeatable)' },
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
    const { protocol, files } = businessServer(project, { log });

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
    const server = createHttpServer({ protocol, files, allowedOrigins: values['allow-origin'] ?? [], log });
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

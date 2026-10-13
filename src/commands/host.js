import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHost } from '../lib/host.js';
import { VERSION } from '../lib/version.js';

export default {
  summary: 'Host many businesses from one folder (the Gentifi network)',
  usage: '--dir <folder> --base-url <https://…> [--port <n>] [--host <address>] [--sync-minutes <n>]',
  options: {
    dir: { type: 'string', description: 'Folder with one sub-folder per business, each holding its gentifi.json' },
    'base-url': { type: 'string', description: 'Public address of this server, such as https://mcp.gentifi.com' },
    port: { type: 'string', description: 'HTTP port (default 8787)' },
    host: { type: 'string', description: 'Address to listen on (default 127.0.0.1, behind a proxy such as Caddy)' },
    'sync-minutes': { type: 'string', description: 'How often to re-read each business\'s sheet (default 10; 0 turns it off)' },
  },
  async run(values, { out, err }) {
    if (!values.dir) {
      err('Say which folder holds the businesses with --dir.');
      return 1;
    }
    const port = Number(values.port ?? 8787);
    const host = values.host ?? '127.0.0.1';
    const baseUrl = values['base-url'] ?? `http://localhost:${port}`;
    const syncMinutes = Number(values['sync-minutes'] ?? 10);
    const log = (m) => out(`${new Date().toISOString()} ${m}`);
    const hosted = createHost({ dir: resolve(values.dir), baseUrl, log });
    await hosted.scan();

    const server = createServer((req, res) => hosted.handle(req, res).catch((e) => {
      log(`Error: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }));
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, host, ok);
    }).catch((e) => {
      err(`Could not listen on ${host}:${port}: ${e.message}`);
    });
    if (!server.listening) return 1;

    out([
      `Gentifi host (gentifi-toolkit ${VERSION}) on ${host}:${port}, public at ${hosted.baseUrl}`,
      `Network connector (every business): ${hosted.baseUrl}/mcp`,
      ...[...hosted.businesses.values()].map((b) => `  ${b.name}: ${hosted.baseUrl}/b/${b.slug}/  (connector ${hosted.baseUrl}/b/${b.slug}/mcp)`),
      hosted.businesses.size ? '' : '  No businesses yet: add a folder with a gentifi.json.',
      syncMinutes > 0 ? `Re-reading sheets and the folder every ${syncMinutes} minutes.` : 'Sheet syncing is off; the folder is checked every minute.',
    ].join('\n'));

    const every = Math.max(syncMinutes, 1) * 60000;
    const timer = setInterval(async () => {
      await hosted.scan();
      if (syncMinutes > 0) await hosted.syncAll();
    }, every);

    await new Promise((done) => {
      const stop = () => {
        clearInterval(timer);
        server.close(done);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  },
};

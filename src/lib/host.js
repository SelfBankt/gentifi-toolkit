import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttpHandler } from '../mcp/http.js';
import { createProtocol } from '../mcp/protocol.js';
import { businessTools } from '../mcp/tools.js';
import { NETWORK_INSTRUCTIONS, networkCard, networkTools, nlwebAsk } from './network.js';
import { VERSION } from './version.js';
import { isBot } from './stats.js';
import { eventCard, eventCollection, eventInstructions, eventPage, loadEvents, memberView } from './events.js';
import { badgeSvg, counterCardSvg, signsHtml } from './badge.js';
import { businessServer } from '../commands/serve.js';
import { diffItems } from '../commands/sync.js';
import { readSource } from './catalogue.js';
import { ProjectError, loadProject, saveProject } from './project.js';

/**
 * Hosts many businesses from one process. Each business is a folder in `dir`
 * named by its slug, holding its gentifi.json, and is served under
 * `${baseUrl}/b/<slug>/`: the scan-to-add page, discovery files, SKILL.md and
 * signs. Customers reach every business through the one network connector at
 * `/mcp`; businesses no longer have their own connector here.
 */

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const sendText = (res, status, text, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
};

export function createHost({ dir, baseUrl, log = () => {}, fetchImpl = globalThis.fetch, stats = null }) {
  const base = baseUrl.replace(/\/+$/, '');
  const businesses = new Map();

  function mount(slug, path, project, mtimeMs) {
    // Hosted URLs replace whatever the project says, so its files point here
    const hosted = { ...project, publish: { ...project.publish, baseUrl: `${base}/b/${slug}`, mcpUrl: `${base}/mcp`, networkUrl: `${base}/mcp` } };
    const { protocol, files } = businessServer(hosted, { log: (m) => log(`[${slug}] ${m}`), onToolCall: () => stats?.count(slug, 'toolCalls') });
    const handler = createHttpHandler({ protocol, files, mcpPath: '/mcp', log: (m) => log(`[${slug}] ${m}`) });
    businesses.set(slug, { slug, path, project, handler, files, tools: businessTools(hosted), mtimeMs, name: project.business.name });
  }

  // Markets, shows and high streets: each gets its own connector, limited to its members
  let events = new Map();
  async function loadAllEvents() {
    const loaded = await loadEvents(dir, log);
    for (const event of loaded.values()) {
      const members = memberView(businesses, event.members);
      event.handler = createHttpHandler({
        protocol: createProtocol({
          serverInfo: { name: `gentifi-${event.slug}`, title: event.name, version: VERSION },
          instructions: eventInstructions(event),
          tools: networkTools(members, { baseUrl: base, stats }),
          log: (m) => log(`[event ${event.slug}] ${m}`),
        }),
        mcpPath: '/mcp',
        log: (m) => log(`[event ${event.slug}] ${m}`),
      });
      event.memberShops = members;
      const missing = event.members.filter((m) => !businesses.has(m));
      if (missing.length) log(`Event ${event.slug}: not hosted yet: ${missing.join(', ')}`);
    }
    events = loaded;
  }

  const network = createHttpHandler({
    protocol: createProtocol({
      serverInfo: { name: 'gentifi', title: 'Gentifi', version: VERSION },
      instructions: NETWORK_INSTRUCTIONS,
      tools: networkTools(businesses, { baseUrl: base, stats }),
      log: (m) => log(`[network] ${m}`),
    }),
    mcpPath: '/mcp',
    log: (m) => log(`[network] ${m}`),
  });

  /** Loads new or changed businesses and drops removed ones. One broken business never stops the others. */
  async function scan() {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      log(`Could not read ${dir}: ${e.message}`);
      return;
    }
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
      const path = join(dir, entry.name, 'gentifi.json');
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      seen.add(entry.name);
      const current = businesses.get(entry.name);
      if (current && current.mtimeMs === info.mtimeMs) continue;
      try {
        mount(entry.name, path, await loadProject(path), info.mtimeMs);
        log(`${current ? 'Reloaded' : 'Loaded'} ${entry.name}`);
      } catch (e) {
        log(`Skipped ${entry.name}: ${e instanceof ProjectError ? e.message : e.stack ?? e.message}`);
      }
    }
    for (const slug of [...businesses.keys()]) {
      if (!seen.has(slug)) {
        businesses.delete(slug);
        log(`Removed ${slug}`);
      }
    }
    await loadAllEvents();
  }

  /** Re-reads each business's online sheet and saves any changes. */
  async function syncAll() {
    for (const b of businesses.values()) {
      const source = b.project.catalogue?.source;
      if (source?.type !== 'csv' || !/^https?:\/\//.test(source.file ?? '')) continue;
      try {
        const imported = await readSource(source, { fetchImpl });
        if (!imported.items.length) {
          log(`[${b.slug}] Sheet has no usable items; kept the last good catalogue`);
          continue;
        }
        const changes = diffItems(b.project.catalogue.items, imported.items);
        if (!changes.length) continue;
        const project = { ...b.project, catalogue: { ...b.project.catalogue, items: imported.items, updatedAt: new Date().toISOString() } };
        await saveProject(b.path, project);
        const info = await stat(b.path);
        mount(b.slug, b.path, project, info.mtimeMs);
        log(`[${b.slug}] Synced: ${changes.join('; ')}`);
      } catch (e) {
        log(`[${b.slug}] Sync failed: ${e.message}`);
      }
    }
  }

  function handleEvent(slug, rest, req, res, url) {
    const event = events.get(slug);
    if (!event) return sendText(res, 404, 'No market, show or high street here.\n');
    if (!rest) return sendText(res, 301, '', { location: `/c/${slug}/${url.search}` });
    const members = [...event.memberShops.values()];
    const page = `${base}/c/${slug}/`;
    const link = event.shortUrl || page;
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    switch (rest) {
      case '/':
      case '/index.html':
        return send('text/html; charset=utf-8', eventPage(event, members, base));
      case '/collection.json':
        return send('application/ai-collection+json', JSON.stringify(eventCollection(event, members, base), null, 2));
      case '/mcp/server-card.json':
        return send('application/mcp-server-card+json', JSON.stringify(eventCard(event, base, VERSION), null, 2));
      case '/badge.svg':
        return send('image/svg+xml', badgeSvg({ businessName: event.name, link }));
      case '/counter-card.svg':
        return send('image/svg+xml', counterCardSvg({ businessName: event.name, link }));
      case '/signs.html':
        return send('text/html; charset=utf-8', signsHtml({ businessName: event.name, link }));
      default:
        req.url = `${rest}${url.search}`;
        return event.handler(req, res);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, businesses: businesses.size }));
    }
    if (url.pathname === '/' || url.pathname === '') {
      return sendText(res, 200, 'Gentifi hosted connectors. Find businesses at https://gentifi.com\n');
    }
    if (url.pathname === '/mcp') return network(req, res);
    if (url.pathname === '/ask') {
      // NLWeb-style natural-language search over every hosted business (non-streaming list mode)
      let params = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') {
        const body = await new Promise((ok, fail) => {
          let data = '';
          req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
          req.on('end', () => ok(data));
          req.on('error', fail);
        });
        try {
          params = { ...params, ...(/json/i.test(req.headers['content-type'] ?? '') ? JSON.parse(body || '{}') : Object.fromEntries(new URLSearchParams(body))) };
        } catch {
          return sendText(res, 400, 'The request body must be JSON or a form.\n');
        }
      }
      if (!String(params.query ?? '').trim()) return sendText(res, 400, 'Ask with a query, such as /ask?query=sourdough\n', { 'access-control-allow-origin': '*' });
      const answer = nlwebAsk(businesses, { query: String(params.query), site: params.site, baseUrl: base, stats });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
      return res.end(JSON.stringify(answer));
    }
    // MCP Server Cards at .well-known (a draft: both the singular and plural paths are in use)
    if (url.pathname === '/.well-known/mcp/server-card.json' || url.pathname === '/.well-known/mcp/server-cards.json') {
      const card = networkCard(base, VERSION);
      const body = url.pathname.endsWith('cards.json')
        ? { servers: [card, ...[...events.values()].map((ev) => eventCard(ev, base, VERSION))] }
        : card;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
      return res.end(JSON.stringify(body, null, 2));
    }
    if (url.pathname === '/.well-known/openai-apps-challenge') {
      // OpenAI's plugin directory checks the domain with a token: put it in <dir>/.openai-apps-challenge
      const token = await readFile(join(dir, '.openai-apps-challenge'), 'utf8').then((t) => t.trim(), () => '');
      return token ? sendText(res, 200, token) : sendText(res, 404, 'No challenge set.\n');
    }
    const c = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (c) return handleEvent(c[1], c[2], req, res, url);
    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const business = m && businesses.get(m[1]);
    if (!business) return sendText(res, 404, 'No business here.\n');
    if (!m[2]) return sendText(res, 301, '', { location: `/b/${m[1]}/${url.search}` });
    if ((m[2] === '/' || m[2] === '/index.html') && req.method === 'GET' && !isBot(req.headers['user-agent'])) stats?.count(business.slug, 'pageViews');
    // Shops' own connectors are retired: point anyone who added one at the network connector
    if (m[2] === '/mcp') return sendText(res, 410, `${business.name} no longer has its own connector. Add the Gentifi connector, ${base}/mcp, and ask about ${business.name} by name.\n`);
    req.url = `${m[2]}${url.search}`;
    return business.handler(req, res);
  }

  return { scan, syncAll, handle, businesses, get events() { return events; }, baseUrl: base };
}

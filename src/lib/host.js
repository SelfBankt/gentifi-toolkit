import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttpHandler } from '../mcp/http.js';
import { createProtocol } from '../mcp/protocol.js';
import { ToolError, businessTools, customerHandoff, priceOrder } from '../mcp/tools.js';
import { confirmPage, confirmedPage, findWitness, linkProblemPage, orderRef, orderSecret, orderToken, ownerAnswerPage, readOrderToken, recordWitness } from './confirm.js';
import { createBot } from './bot.js';
import { businessProfile, offeringIds } from './profile.js';
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
 * `/mcp`; businesses no longer have their own connector here. Orders prepared
 * on it are confirmed by the customer at `/o/<link>` (see confirm.js).
 *
 * With the owner bot on (bot.js), each business's folder also gets a
 * gentifi-profile.json for the bot to read, rewritten when the business changes,
 * and orders for owners on Telegram go to them there.
 *
 * Businesses the bot is still onboarding (GENTIFI_ONBOARDING_FILE, the bot's
 * onboarding.json) are loaded but hidden from customers' agents, pages and order
 * links until their owner checks the listing and goes live. If the file can't be
 * read, the last list read stands, so a hidden business never shows by accident.
 *
 * What owners mark sold out or back in stock in Telegram (GENTIFI_STOCK_FILE, the
 * bot's stock.json) is shown to customers' agents over the sheet, unless the sheet
 * was read again after the mark. The saved project and the bot's profile keep the
 * sheet's own stock.
 */

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const sendText = (res, status, text, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
};

/** A bot file (JSON), read again when it changes. `read()` gives its new contents, or undefined if unchanged or unreadable. */
function botFile(file, parse, log, checkMs) {
  let mtime = null;
  let checkedAt = 0;
  return async function read(force = false) {
    if (!file || (!force && Date.now() - checkedAt < checkMs)) return undefined;
    checkedAt = Date.now();
    let info;
    try {
      info = await stat(file);
    } catch {
      return undefined; // not there (yet): keep the last one
    }
    if (info.mtimeMs === mtime) return undefined;
    try {
      const value = parse(JSON.parse(await readFile(file, 'utf8')));
      mtime = info.mtimeMs;
      return value;
    } catch (e) {
      log(`Couldn't read ${file}, keeping the last one: ${e.message}`);
      return undefined;
    }
  };
}

/**
 * The project as customers' agents see it: the owner's marks from Telegram (by offering
 * id: { status, at }) over the sheet's stock, where they're newer than the sheet.
 */
export function withOwnerStock(project, marks = {}) {
  const ids = offeringIds(project.catalogue.items);
  const sheetAt = Date.parse(project.catalogue.updatedAt ?? '') || 0;
  const items = project.catalogue.items.map((item) => {
    const mark = marks[ids.get(item.sku)];
    if (!mark || !(Date.parse(mark.at) > sheetAt)) return item;
    if (mark.status === 'out_of_stock') return { ...item, stock: 0, inStock: false };
    if (mark.status === 'in_stock') return { ...item, stock: null, inStock: true }; // how many isn't known
    return item;
  });
  return { ...project, catalogue: { ...project.catalogue, items } };
}

export function createHost({ dir, baseUrl, log = () => {}, fetchImpl = globalThis.fetch, stats = null, env = process.env, botCheckMs = 5000 }) {
  const base = baseUrl.replace(/\/+$/, '');
  const mounted = new Map(); // every business loaded from the folder
  const businesses = new Map(); // the ones customers' agents can see: mounted, less those onboarding
  let secret = null;
  let onboarding = new Set();
  let stock = {}; // owners' marks by business profile id
  const readOnboarding = botFile(env.GENTIFI_ONBOARDING_FILE ?? '', (doc) => {
    if (!Array.isArray(doc.onboarding)) throw new Error('no "onboarding" list');
    return new Set(doc.onboarding.map(String));
  }, log, botCheckMs);
  const readStock = botFile(env.GENTIFI_STOCK_FILE ?? '', (doc) => {
    if (!doc.stock || typeof doc.stock !== 'object') throw new Error('no "stock" marks');
    return doc.stock;
  }, log, botCheckMs);
  const bot = createBot({ env, log });

  async function mount(slug, path, sheet, mtimeMs) {
    const profileId = businessProfile(sheet).business.id;
    const marks = stock[profileId] ?? {};
    const project = withOwnerStock(sheet, marks);
    // Hosted URLs replace whatever the project says, so its files point here
    const hosted = { ...project, publish: { ...project.publish, baseUrl: `${base}/b/${slug}`, mcpUrl: `${base}/mcp`, networkUrl: `${base}/mcp` } };
    // The order rides in the signed link, so preparing one stores nothing
    const confirmLink = ({ items, collectionDate, note }) => `${base}/o/${orderToken(secret, {
      business: slug, items, collectionDate, note, pricesAsOf: project.catalogue.updatedAt, preparedAt: new Date().toISOString(),
    })}`;
    const { protocol, files } = businessServer(hosted, { log: (m) => log(`[${slug}] ${m}`), onToolCall: () => stats?.count(slug, 'toolCalls'), confirmLink });
    const handler = createHttpHandler({ protocol, files, mcpPath: '/mcp', log: (m) => log(`[${slug}] ${m}`) });
    mounted.set(slug, { slug, path, project, sheet, marks: JSON.stringify(marks), handler, files, tools: businessTools(hosted, { confirmLink }), mtimeMs, name: project.business.name, profileId });
    showVisible();
    if (bot) await writeProfile(slug, sheet).catch((e) => log(`[${slug}] Couldn't write gentifi-profile.json: ${e.message}`));
  }

  /** The business as a Gentifi Business Profile, for the owner bot; only rewritten when it changes. */
  async function writeProfile(slug, project) {
    const file = join(dir, slug, 'gentifi-profile.json');
    const json = `${JSON.stringify(businessProfile(project), null, 2)}\n`;
    if (await readFile(file, 'utf8').catch(() => '') === json) return;
    await writeFile(`${file}.tmp`, json);
    await rename(`${file}.tmp`, file); // the bot never reads half a file
  }

  /** Re-reads the bot's onboarding list and stock marks if they changed (at most every 5 seconds unless forced). */
  async function refreshBotFiles(force = false) {
    const list = await readOnboarding(force);
    if (list) {
      onboarding = list;
      showVisible();
    }
    const marks = await readStock(force);
    if (!marks) return;
    stock = marks;
    for (const b of [...mounted.values()]) {
      if (JSON.stringify(stock[b.profileId] ?? {}) === b.marks) continue;
      try {
        await mount(b.slug, b.path, b.sheet, b.mtimeMs);
        log(`[${b.slug}] Stock updated from its owner`);
      } catch (e) {
        log(`[${b.slug}] Couldn't update stock from its owner: ${e.message}`);
      }
    }
  }

  /** Rebuilds the visible list in place (the network connector, events and pages all read it). */
  function showVisible() {
    const before = new Set(businesses.keys());
    businesses.clear();
    for (const [slug, b] of mounted) {
      if (onboarding.has(b.profileId)) {
        if (before.has(slug)) log(`Hidden while its owner checks the listing: ${slug}`);
      } else {
        businesses.set(slug, b);
      }
    }
  }

  /** Does this order go to the owner in Telegram? Only for businesses that take reservations. */
  async function viaTelegram(project) {
    return Boolean(bot) && project.ordering?.method === 'reserve' && await bot.onTelegram(businessProfile(project).business.id);
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
    secret ??= await orderSecret(dir, env);
    await refreshBotFiles(true); // before loading anything, so a new business never shows early
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
      const current = mounted.get(entry.name);
      if (current && current.mtimeMs === info.mtimeMs) continue;
      try {
        await mount(entry.name, path, await loadProject(path), info.mtimeMs);
        log(`${current ? 'Reloaded' : 'Loaded'} ${entry.name}`);
      } catch (e) {
        log(`Skipped ${entry.name}: ${e instanceof ProjectError ? e.message : e.stack ?? e.message}`);
      }
    }
    for (const slug of [...mounted.keys()]) {
      if (!seen.has(slug)) {
        mounted.delete(slug);
        log(`Removed ${slug}`);
      }
    }
    showVisible();
    await loadAllEvents();
  }

  /** Re-reads each business's online sheet and saves any changes. */
  async function syncAll() {
    for (const b of mounted.values()) {
      const source = b.project.catalogue?.source;
      if (!source?.type || !/^https?:\/\//.test(source.file ?? '')) continue;
      try {
        const imported = await readSource(source, { fetchImpl });
        if (!imported.items.length) {
          log(`[${b.slug}] Sheet has no usable items; kept the last good catalogue`);
          continue;
        }
        const changes = diffItems(b.sheet.catalogue.items, imported.items);
        if (!changes.length) continue;
        const project = { ...b.sheet, catalogue: { ...b.sheet.catalogue, items: imported.items, updatedAt: new Date().toISOString() } };
        await saveProject(b.path, project);
        const info = await stat(b.path);
        await mount(b.slug, b.path, project, info.mtimeMs);
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

  /** The customer's confirmation page. GET only shows the order; the Confirm button POSTs. */
  async function handleConfirm(token, req, res) {
    const page = (status, html, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : html);
    };
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return sendText(res, 405, 'Method not allowed.\n', { allow: 'GET, HEAD, POST' });
    const order = secret && readOrderToken(secret, token);
    if (!order) return page(404, linkProblemPage('This link has expired or isn’t complete. Order links last a week.'));
    const business = businesses.get(order.business);
    if (!business) return page(404, linkProblemPage('This business isn’t on Gentifi any more.'));
    const { project } = business;
    const currency = project.business.currency || 'GBP';
    let priced;
    try {
      priced = priceOrder(project.catalogue.items, order.items, currency);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      return page(409, linkProblemPage(`Something in this order isn’t sold by ${project.business.name} any more.`));
    }
    const ref = orderRef(token);
    const changed = order.pricesAsOf !== project.catalogue.updatedAt;
    const businessId = businessProfile(project).business.id;
    if (req.method === 'POST') {
      const form = await readForm(req);
      // Record once: confirming twice changes nothing
      if (!await findWitness(dir, business.slug, ref)) {
        let handedTo = null;
        if (await viaTelegram(project)) {
          const values = { name: (form.get('name') ?? '').trim(), contact: (form.get('contact') ?? '').trim() };
          if (!values.name || !values.contact) {
            return page(400, confirmPage({ project, order, priced, changed, askContact: true, values,
              problem: `Add your name and a phone number or email, so ${project.business.name} can reach you.` }));
          }
          const ids = offeringIds(project.catalogue.items);
          const sent = await bot.send({
            business_id: businessId, ref, confirmed_at: new Date().toISOString(),
            items: priced.lines.map((l) => ({ offering_id: ids.get(l.sku), quantity: l.quantity })),
            customer: { name: values.name.slice(0, 100), contact: values.contact.slice(0, 100) },
            collection_date: order.collectionDate || undefined, note: order.note || undefined,
          });
          if (sent) handedTo = 'telegram';
        }
        await recordWitness(dir, business.slug, { ref, order, priced, currency, handedTo });
        stats?.count(business.slug, 'confirmations');
        log(`[${business.slug}] Order ${ref} confirmed${handedTo ? ', sent to the owner on Telegram' : ''}`);
      }
      return page(303, '', { location: `/o/${token}` });
    }
    const witness = await findWitness(dir, business.slug, ref);
    if (witness) {
      const handoff = customerHandoff(project, priced.lines, priced.total, { collectionDate: order.collectionDate, note: order.note, ref });
      if (witness.handedTo === 'telegram') {
        return page(200, ownerAnswerPage({ project, priced, ref, handoff, state: await bot?.status(businessId, ref) }));
      }
      return page(200, confirmedPage({ project, priced, ref, handoff, confirmedAt: witness.confirmedAt }));
    }
    return page(200, confirmPage({ project, order, priced, changed, askContact: await viaTelegram(project) }));
  }

  /** The Confirm form's fields (a few short ones; anything larger is cut off). */
  async function readForm(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) break;
    }
    return new URLSearchParams(body.slice(0, 4096));
  }

  async function handle(req, res) {
    await refreshBotFiles();
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
    const o = /^\/o\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
    if (o) return handleConfirm(o[1], req, res);
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

  return { scan, syncAll, handle, businesses, mounted, get events() { return events; }, baseUrl: base };
}

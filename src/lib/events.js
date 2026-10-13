import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ADD_STEPS, TESTED_APPS } from './apps.js';
import { escapeXml as e } from './badge.js';
import { COLLECTIONS_NS, SERVER_CARD_SCHEMA } from './outputs.js';
import { COLLECTION_TYPE, KINDS } from './collections.js';
import { SUPPORTED_VERSIONS } from '../mcp/protocol.js';

/**
 * Markets, shows and high streets: a group of hosted businesses that visitors add
 * once. Each is a settings file in <dir>/_collections/<slug>.json:
 *
 *   { "name": "Chipping Sodbury Market", "kind": "event", "members": ["hobbs-house", ...],
 *     "description": "...", "validFrom": "2026-11-07", "validTo": "2026-11-07",
 *     "area": { "country": "GB", "postalCodes": ["BS37"] } }
 *
 * The host serves each at /c/<slug>/: a page to add it, its own connector at
 * /c/<slug>/mcp (the network connector, limited to its members), its signs, and a
 * Business Collections draft 0.2 document at /c/<slug>/collection.json.
 */

export const EVENTS_DIR = '_collections';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Reads every event's settings. A broken file is skipped and reported, never fatal. */
export async function loadEvents(dir, log = () => {}) {
  const events = new Map();
  let files = [];
  try {
    files = await readdir(join(dir, EVENTS_DIR));
  } catch {
    return events;
  }
  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !SLUG.test(slug)) continue;
    try {
      const settings = JSON.parse(await readFile(join(dir, EVENTS_DIR, file), 'utf8'));
      const problems = [];
      if (typeof settings.name !== 'string' || !settings.name.trim()) problems.push('name is required');
      if (!KINDS.includes(settings.kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`);
      if (!Array.isArray(settings.members) || !settings.members.length || !settings.members.every((m) => SLUG.test(m))) problems.push('members must list business folder names');
      if (problems.length) {
        log(`Skipped event ${slug}: ${problems.join('; ')}`);
        continue;
      }
      events.set(slug, { slug, ...settings });
    } catch (err) {
      log(`Skipped event ${slug}: ${err.message}`);
    }
  }
  return events;
}

/** The hosted businesses that belong to an event, as a map the network tools can use. */
export function memberView(businesses, members) {
  const allowed = new Set(members);
  return {
    get: (slug) => (allowed.has(slug) ? businesses.get(slug) : undefined),
    values: () => [...businesses.values()].filter((b) => allowed.has(b.slug)).values(),
    get size() {
      return [...businesses.keys()].filter((k) => allowed.has(k)).length;
    },
  };
}

export const eventInstructions = (event) => `This connector covers the traders at ${event.name}, using their own catalogues. `
  + 'When the customer asks what is on offer or names a trader, use find_businesses first, then pass its id as business to the other tools. '
  + 'Prices and stock can change: say when they were last updated. '
  + 'Nothing is ordered through this server. prepare_order returns a summary and a link: show the customer the summary and let them confirm with the trader themselves.';

export function eventCard(event, base, version) {
  const host = new URL(base).hostname;
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: `${host.split('.').reverse().join('.')}/c-${event.slug}`,
    version,
    title: event.name.slice(0, 100),
    description: `The traders at ${event.name}: their products, prices, stock and ordering`.slice(0, 100),
    websiteUrl: `${base}/c/${event.slug}/`,
    remotes: [{ type: 'streamable-http', url: `${base}/c/${event.slug}/mcp`, supportedProtocolVersions: SUPPORTED_VERSIONS }],
  };
}

/** The event as a Business Collections draft 0.2 document: an ARD manifest whose entries are its members. */
export function eventCollection(event, members, base) {
  const host = new URL(base).hostname;
  const entries = [];
  for (const b of members) {
    const ard = JSON.parse(b.files.get('ard.json'));
    const mcp = ard.entries.find((x) => x.type === 'application/mcp-server-card+json');
    if (!mcp) continue;
    // Identified by the hosting folder, which is unique, and addressed on this host
    entries.push({
      '@context': { col: COLLECTIONS_NS },
      ...mcp,
      identifier: `urn:air:${host}:mcp:${b.slug}`,
      url: `${base}/b/${b.slug}/mcp/server-card.json`,
      'col:manifest': `${base}/b/${b.slug}/ard.json`,
    });
  }
  return {
    '@context': ['https://agenticresourcediscovery.org/context/v1', { col: COLLECTIONS_NS }],
    collection: {
      id: `urn:air:${host}:collection:${event.slug}`,
      name: event.name,
      kind: event.kind,
      ...(event.description ? { description: event.description } : {}),
      publisher: { name: 'Gentifi', domain: host },
      ...(event.validFrom ? { validFrom: event.validFrom } : {}),
      ...(event.validTo ? { validTo: event.validTo } : {}),
      ...(event.area ? { area: event.area } : {}),
      connector: `${base}/c/${event.slug}/mcp`,
    },
    entries,
  };
}

/** The page a visitor's phone opens from the event's sign. */
export function eventPage(event, members, base) {
  const link = `${base}/c/${event.slug}/mcp`;
  const linked = (text) => e(text).replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}\/[\w/-]*\w)/g, '<a href="https://$1">$1</a>');
  const steps = TESTED_APPS.map((app) => `<li><strong>${e(app)}:</strong> ${linked(ADD_STEPS[app])}</li>`).join('');
  const first = members[0];
  const thing = first?.project.catalogue.items[0]?.name?.replace(/\s*\(.*\)$/, '').toLowerCase();
  const example = thing ? `“Which stalls have ${thing}?”` : '“What can I buy here?”';
  const when = [event.validFrom, event.validTo].filter(Boolean);
  const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dates = when.length ? new Set(when).size === 1 ? day(when[0]) : `${day(when[0])} to ${day(when[1])}` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ask your AI about ${e(event.name)}</title>
<meta name="description" content="${e(`Add ${event.name} to your AI assistant once, then ask across every trader.`)}">
<link rel="alternate" type="${COLLECTION_TYPE}" href="collection.json">
<style>
  :root { --teal: #05414D; --line: #1C5D69; --copper: #F09A5C; --grey: #E9EDF2; --muted: #B8C4D3; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Sora, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--teal); background: #fff; line-height: 1.55; }
  .shell { max-width: 560px; margin: 0 auto; padding: 0 16px; }
  header { background: var(--teal); color: #fff; padding: 28px 0 32px; }
  .when { color: var(--copper); font-size: .9rem; margin: 0 0 6px; }
  h1 { font-size: clamp(1.6rem, 7vw, 2.1rem); line-height: 1.15; margin: 0 0 12px; }
  .lede { color: var(--muted); margin: 0 0 20px; }
  .steps { margin: 0; padding-left: 1.4em; display: grid; gap: 16px; }
  .steps li::marker { color: var(--copper); font-weight: 700; }
  .steps ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .steps a { color: #fff; font-weight: 600; }
  .connector { display: flex; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-top: 8px; }
  .connector code { flex: 1; padding: 12px 14px; font-size: .85rem; overflow-wrap: anywhere; color: #fff; }
  button { font: inherit; font-weight: 600; border: 0; background: var(--copper); color: var(--teal); padding: 0 18px; min-height: 48px; cursor: pointer; }
  .approve { font-size: .9rem; color: var(--muted); margin: 18px 0 0; }
  main { padding: 28px 0 40px; }
  h2 { font-size: 1.15rem; margin: 0 0 12px; }
  .traders { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .traders a { display: block; padding: 12px 14px; background: var(--grey); border-radius: 10px; color: var(--teal); font-weight: 600; text-decoration: none; }
  .traders span { display: block; font-weight: 400; font-size: .9rem; color: #3D4A5C; }
  footer { font-size: .85rem; color: #3D4A5C; padding: 0 0 32px; }
  footer a { color: var(--teal); }
</style>
</head>
<body>
<header>
  <div class="shell">
    ${dates ? `<p class="when">${e(dates)}</p>` : ''}
    <h1>Add ${e(event.name)} to your AI assistant</h1>
    <p class="lede">Then ask across every trader at once: what they have, prices and opening times, or to reserve something. You approve the connection, and every order, yourself.</p>
    <ol class="steps">
      <li>Copy this link.
        <div class="connector"><code>${e(link)}</code><button type="button" data-copy="${e(link)}">Copy</button></div>
      </li>
      <li><ul>${steps}</ul></li>
      <li>Ask, for example: ${e(example)}</li>
    </ol>
    <p class="approve">Using another AI app? Paste the link wherever it lets you add connectors. Your app asks you to approve it, and nothing is added silently.</p>
  </div>
</header>
<main>
  <div class="shell">
    <h2>${members.length} trader${members.length === 1 ? '' : 's'} at ${e(event.name)}</h2>
    <ul class="traders">
      ${members.map((b) => `<li><a href="${e(`${base}/b/${b.slug}/`)}">${e(b.name)}${b.project.business.kind ? `<span>${e(b.project.business.kind)}</span>` : ''}</a></li>`).join('\n      ')}
    </ul>
  </div>
</main>
<footer><div class="shell">Every trader keeps its own prices and checkout. <a href="https://gentifi.com/events">Gentifi for markets, shows and high streets</a></div></footer>
<script>
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  }));
</script>
</body>
</html>
`;
}

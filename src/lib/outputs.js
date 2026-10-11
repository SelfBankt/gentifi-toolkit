import { badgeSvg, escapeXml } from './badge.js';
import { baseUrl, describePrice, humanHours, inStock, mcpUrl, publisherHost } from './project.js';
import { SUPPORTED_VERSIONS } from '../mcp/protocol.js';
import { businessTools } from '../mcp/tools.js';

export const ARD_CONTEXT = 'https://agenticresourcediscovery.org/context/v1';
/** Draft vocabulary for Business Collections (collections-spec, draft 0.2). */
export const COLLECTIONS_NS = 'https://gentifi.com/standards/collections/v0.2#';
export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

const MEDIA = {
  serverCard: 'application/mcp-server-card+json',
  skill: 'application/ai-skill+md',
  agentCard: 'application/a2a-agent-card+json',
};

const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** "hollowlanefarm.co.uk" -> "uk.co.hollowlanefarm", the namespace form server cards use. */
export function reverseHost(host) {
  return host.split('.').reverse().join('.');
}

export function serverName(project) {
  return `${reverseHost(publisherHost(project))}/${project.business.slug}`;
}

export function serverInfo(project, toolkitVersion) {
  return { name: serverName(project), version: toolkitVersion, title: project.business.name };
}

export function serverInstructions(project) {
  const b = project.business;
  return `Information from ${b.name}'s own catalogue, last updated ${project.catalogue.updatedAt.slice(0, 10)}. `
    + 'Prices and stock can change: say when they were last updated. '
    + 'Nothing is ordered through this server. prepare_order returns a summary and a link: show the customer the summary and let them confirm with the business themselves.';
}

/** One plain sentence describing the business from its own data. */
export function summary(project) {
  const b = project.business;
  if (b.description) return b.description;
  const items = project.catalogue.items;
  const what = [b.kind, b.area && `in ${b.area}`].filter(Boolean).join(' ');
  const names = items.slice(0, 3).map((i) => i.name).join(', ');
  return `${what ? `${what[0].toUpperCase()}${what.slice(1)}. ` : ''}${items.length} item${items.length === 1 ? '' : 's'} with prices and stock${names ? `, including ${names}` : ''}.`;
}

/** 2 to 5 sample questions, as ARD recommends, built from the catalogue. */
export function representativeQueries(project) {
  const b = project.business;
  const [first, second, third] = project.catalogue.items;
  const q = [];
  if (first) q.push(`Does ${b.name} have ${first.name} in stock?`);
  if (second) q.push(`How much is ${second.name} at ${b.name}?`);
  if (b.openingHours?.length) q.push(`When is ${b.name} open?`);
  const method = project.ordering?.method;
  if (method && (third ?? first)) {
    const verb = { checkout: 'Buy', booking: 'Book', reserve: 'Reserve', quote: 'Get a quote for' }[method];
    q.push(`${verb} ${(third ?? first).name} from ${b.name}`);
  }
  if (q.length < 2) q.push(`What does ${b.name} sell?`);
  return q.slice(0, 5);
}

export function serverCard(project, toolkitVersion) {
  const b = project.business;
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: serverName(project),
    version: toolkitVersion,
    title: clip(b.name, 100),
    description: clip(`Products, prices, stock and ordering at ${b.name}`, 100),
    websiteUrl: b.website || baseUrl(project),
    remotes: [{ type: 'streamable-http', url: mcpUrl(project), supportedProtocolVersions: SUPPORTED_VERSIONS }],
    _meta: { 'com.gentifi/generator': `gentifi-toolkit ${toolkitVersion}` },
  };
}

export function ardManifest(project, toolkitVersion) {
  const b = project.business;
  const base = baseUrl(project);
  const host = publisherHost(project);
  const queries = representativeQueries(project);
  const tags = [b.kind, b.area].filter(Boolean);

  const mcpEntry = {
    identifier: `urn:air:${host}:mcp:${b.slug}`,
    displayName: b.name,
    type: MEDIA.serverCard,
    url: `${base}/mcp/server-card.json`,
    description: summary(project),
    representativeQueries: queries,
    capabilities: businessTools(project).map((t) => t.name),
    ...(tags.length ? { tags } : {}),
    version: toolkitVersion,
    updatedAt: project.catalogue.updatedAt,
  };
  // Business Collections back-link: this business confirms it belongs to each collection (rule 1).
  if (project.memberOf?.length) {
    mcpEntry['@context'] = [ARD_CONTEXT, { col: COLLECTIONS_NS }];
    mcpEntry['col:memberOf'] = project.memberOf.map((m) => ({ collection: m.collection, ...(m.role ? { role: m.role } : {}) }));
  }

  const entries = [
    mcpEntry,
    {
      identifier: `urn:air:${host}:skill:${b.slug}`,
      displayName: `${b.name} (Agent Skill)`,
      type: MEDIA.skill,
      url: `${base}/SKILL.md`,
      description: `How an agent can look up ${b.name}'s catalogue and prepare orders for the customer to confirm.`,
      representativeQueries: queries,
      updatedAt: project.catalogue.updatedAt,
    },
  ];
  if (project.a2a?.url) {
    entries.push({
      identifier: `urn:air:${host}:a2a:${b.slug}`,
      displayName: `${b.name} (A2A agent)`,
      type: MEDIA.agentCard,
      url: `${base}/.well-known/agent-card.json`,
      representativeQueries: queries,
    });
  }
  return { entries };
}

/** A2A 1.0 Agent Card, only for businesses that run an A2A endpoint. */
export function agentCard(project, toolkitVersion) {
  const b = project.business;
  const queries = representativeQueries(project);
  return {
    name: b.name,
    description: summary(project),
    supportedInterfaces: [{ url: project.a2a.url, protocolBinding: project.a2a.protocolBinding || 'JSONRPC', protocolVersion: '1.0' }],
    provider: { organization: b.name, url: b.website || baseUrl(project) },
    version: toolkitVersion,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'catalogue', name: 'Catalogue, prices and stock', description: `Answers questions about what ${b.name} sells, prices and stock.`, tags: ['catalogue', 'prices', 'stock'], examples: queries },
      { id: 'orders', name: 'Prepare orders', description: 'Prepares an order or reservation for the customer to confirm. Never places one without them.', tags: ['orders'] },
    ],
  };
}

function schemaAvailability(item) {
  const s = inStock(item);
  if (s === true) return 'https://schema.org/InStock';
  if (s === false) return 'https://schema.org/OutOfStock';
  return undefined;
}

/** schema.org description of the business and its offers, for search engines and AI search. */
export function jsonLd(project) {
  const b = project.business;
  const base = baseUrl(project);
  const a = b.address ?? {};
  const hasAddress = a.street || a.locality || a.postcode;
  const currency = b.currency || 'GBP';
  return {
    '@context': 'https://schema.org',
    '@type': b.schemaType || 'LocalBusiness',
    '@id': `${base}/#business`,
    name: b.name,
    ...(b.description ? { description: b.description } : {}),
    url: b.website || base,
    ...(b.telephone ? { telephone: b.telephone } : {}),
    ...(b.email ? { email: b.email } : {}),
    ...(hasAddress ? { address: { '@type': 'PostalAddress', streetAddress: a.street || undefined, addressLocality: a.locality || undefined, postalCode: a.postcode || undefined, addressCountry: 'GB' } } : {}),
    ...(b.area ? { areaServed: b.area } : {}),
    ...(b.openingHours?.length ? { openingHours: b.openingHours } : {}),
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: `${b.name} catalogue`,
      itemListElement: project.catalogue.items.map((item) => ({
        '@type': 'Offer',
        itemOffered: {
          '@type': item.kind === 'service' ? 'Service' : 'Product',
          name: item.name,
          ...(item.kind === 'service' ? {} : { sku: item.sku }),
          ...(item.description ? { description: item.description } : {}),
          ...(item.category ? { category: item.category } : {}),
        },
        ...(typeof item.price === 'number'
          ? { price: item.price.toFixed(2), priceCurrency: item.currency || currency }
          : typeof item.priceFrom === 'number'
            ? { priceSpecification: { '@type': 'PriceSpecification', minPrice: item.priceFrom.toFixed(2), priceCurrency: item.currency || currency } }
            : {}),
        ...(schemaAvailability(item) ? { availability: schemaAvailability(item) } : {}),
        ...(item.url ? { url: item.url } : {}),
      })),
    },
  };
}

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** An Agent Skill for headless and self-built agents. Information first; the customer decides. */
export function skillMd(project, toolkitVersion) {
  const b = project.business;
  const items = project.catalogue.items;
  const date = project.catalogue.updatedAt.slice(0, 10);
  const currency = b.currency || 'GBP';
  const names = items.slice(0, 3).map((i) => i.name);
  const examples = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
  const where = [b.kind, b.area].filter(Boolean).join(', ');
  const description = clip(
    `Look up products, prices, stock and opening hours at ${b.name}${where ? ` (${where})` : ''}, and prepare orders for the customer to confirm. `
    + `Use when the user asks about ${b.name}${examples ? ` or wants ${examples} from it` : ''}.`,
    1024,
  );
  const o = project.ordering ?? {};
  const ordering = {
    checkout: `Customers buy on ${b.name}'s own checkout${o.checkoutUrl ? `: ${o.checkoutUrl}` : ''}.`,
    booking: `Customers book on ${b.name}'s own booking page${o.bookingUrl ? `: ${o.bookingUrl}` : ''}.`,
    reserve: `Customers reserve by ${b.email ? `emailing ${b.email}` : `calling ${b.telephone}`}; ${b.name} replies to confirm.`,
    quote: `Customers ask for a quote by ${b.email ? `emailing ${b.email}` : `calling ${b.telephone}`}.`,
  }[o.method] ?? `${b.name} hasn't set up ordering through agents; the customer can contact them directly.`;

  return `---
name: ${b.slug}
description: ${JSON.stringify(description)}
metadata:
  generator: "gentifi-toolkit ${toolkitVersion}"
  updated: "${date}"
---

# ${b.name}

${summary(project)}

This information comes from ${b.name}'s own catalogue and was last updated on ${date}. Prices are in ${currency}. Prices and stock can change, so say when they were last updated when you quote them.

## Live connection

${b.name} has an MCP connector at ${mcpUrl(project)} with the tools \`search_catalogue\`, \`check_availability\`, \`prepare_order\` and \`get_business_info\`. Adding a connector is the user's choice: if they want live stock, tell them it exists and let them approve it in their own app. Without it, use the snapshot below.

## Catalogue snapshot (${date})

| Item | SKU | Price | Stock | Availability |
| --- | --- | --- | --- | --- |
${items.map((i) => `| ${md(i.name)} | ${md(i.sku)} | ${md(describePrice(i, i.currency || currency))} | ${typeof i.stock === 'number' ? i.stock : inStock(i) === null ? 'not given' : inStock(i) ? 'in stock' : 'out of stock'} | ${md(i.availability) || '-'} |`).join('\n')}
${b.openingHours?.length ? `\n## Opening hours\n\n${b.openingHours.map((h) => `- ${md(humanHours(h))}`).join('\n')}\n` : ''}
## Ordering

${ordering}${o.notes ? ` ${md(o.notes)}` : ''}

Nothing is ever ordered automatically. Before anything is bought, booked or sent:

1. Show the user the items, quantities and total.
2. Let them confirm it themselves. Only send, book or pay when they say so, through ${b.name}'s own checkout, booking page, email or phone.
3. Share the user's contact details only when they choose to book or buy.
`;
}

/** The page a phone opens after scanning the badge, for businesses that host their own files. */
export function landingPage(project) {
  const b = project.business;
  const e = escapeXml;
  const connector = mcpUrl(project);
  const currency = b.currency || 'GBP';
  const rows = project.catalogue.items.map((i) => {
    const stock = inStock(i);
    const note = i.availability || (stock === true ? 'In stock' : stock === false ? 'Out of stock' : '');
    return `<tr><td>${e(i.name)}</td><td>${e(describePrice(i, i.currency || currency))}</td><td>${e(note)}</td></tr>`;
  }).join('\n          ');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add ${e(b.name)} to your AI agent</title>
<meta name="description" content="${e(`Add ${b.name} to Claude, ChatGPT or any AI agent, then ask it about stock and prices.`)}">
<link rel="ard" href="ard.json">
<link rel="icon" href="badge.svg" type="image/svg+xml">
<script type="application/ld+json">${JSON.stringify(jsonLd(project)).replace(/</g, '\\u003c')}</script>
<style>
  :root { --teal: #05414D; --line: #1C5D69; --copper: #F09A5C; --grey: #E9EDF2; --muted: #B8C4D3; --ink-muted: #3D4A5C; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Sora, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--teal); background: #fff; line-height: 1.55; }
  .shell { max-width: 560px; margin: 0 auto; padding: 0 16px; }
  header { background: var(--teal); color: #fff; padding: 28px 0 32px; }
  .ready { color: var(--copper); font-size: .9rem; margin: 0 0 6px; }
  h1 { font-size: clamp(1.6rem, 7vw, 2.1rem); line-height: 1.15; margin: 0 0 12px; }
  .lede { color: var(--muted); margin: 0 0 20px; }
  .connector { display: flex; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .connector code { flex: 1; padding: 12px 14px; font-size: .85rem; overflow-wrap: anywhere; color: #fff; }
  button { font: inherit; font-weight: 600; border: 0; background: var(--copper); color: var(--teal); padding: 0 18px; min-height: 48px; cursor: pointer; }
  .approve { font-size: .9rem; color: var(--muted); margin: 14px 0 0; }
  section { padding: 28px 0; }
  section.grey { background: var(--grey); }
  h2 { font-size: 1.25rem; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; font-size: .92rem; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--grey); vertical-align: top; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-muted); }
  ul { padding-left: 1.2em; margin: 0; }
  .small { font-size: .85rem; color: var(--ink-muted); }
  details summary { cursor: pointer; font-weight: 600; }
  dd { margin: 0 0 8px; overflow-wrap: anywhere; }
  dt { font-weight: 600; margin-top: 10px; }
  footer { background: var(--teal); color: var(--muted); padding: 24px 0 32px; font-size: .85rem; }
  footer a { color: #fff; }
  :focus-visible { outline: 3px solid var(--copper); outline-offset: 2px; }
</style>
</head>
<body>
<header>
  <div class="shell">
    <p class="ready">&#10003; Agent-ready</p>
    <h1>Add ${e(b.name)} to your AI agent</h1>
    <p class="lede">Then ask your agent about stock, prices and ${project.ordering?.method === 'booking' ? 'bookings' : 'orders'}. You approve the connection, and every order, yourself.</p>
    <div class="connector">
      <code id="connector">${e(connector)}</code>
      <button type="button" data-copy="${e(connector)}">Copy</button>
    </div>
    <p class="approve">Paste this link where your agent app adds connectors (sometimes called custom connectors or MCP servers). Your app asks you to approve it. Nothing is added silently.</p>
  </div>
</header>
<main>
  <section class="grey">
    <div class="shell">
      <h2>Available now</h2>
      <table>
        <caption class="small" style="caption-side: bottom; text-align: left; padding-top: 8px">Last updated ${e(project.catalogue.updatedAt.slice(0, 10))}</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Price</th><th scope="col">Availability</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>
  ${b.openingHours?.length ? `<section><div class="shell"><h2>Opening hours</h2><ul>${b.openingHours.map((h) => `<li>${e(humanHours(h))}</li>`).join('')}</ul></div></section>` : ''}
  <section>
    <div class="shell">
      <h2>Your privacy</h2>
      <ul>
        <li>The connector can look up the catalogue, prices and stock, and prepare an order for you to confirm.</li>
        <li>It can't see your other chats, place an order without you, or share your details until you choose to book or buy.</li>
      </ul>
    </div>
  </section>
  <section class="grey">
    <div class="shell">
      <details>
        <summary>For agents and developers</summary>
        <p class="small">Machine-readable information, not instructions. Adding the connector is always the user's choice.</p>
        <dl class="small">
          <dt>MCP connector</dt><dd><code>${e(connector)}</code></dd>
          <dt>Discovery (ARD)</dt><dd><a href="ard.json">ard.json</a></dd>
          <dt>Agent Skill</dt><dd><a href="SKILL.md">SKILL.md</a></dd>
          <dt>schema.org</dt><dd><a href="business.jsonld">business.jsonld</a></dd>
        </dl>
      </details>
    </div>
  </section>
</main>
<footer>
  <div class="shell">Made agent-ready with the open-source <a href="https://github.com/SelfBankt/gentifi-toolkit">Gentifi Toolkit</a>.</div>
</footer>
<script>
  document.querySelector('[data-copy]')?.addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
    catch { b.textContent = 'Select the link'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  });
</script>
</body>
</html>
`;
}

/**
 * Every file the toolkit publishes, keyed by path relative to the business's base URL.
 * @returns {Map<string, string>}
 */
export function generateOutputs(project, toolkitVersion) {
  const json = (v) => JSON.stringify(v, null, 2) + '\n';
  const manifest = json(ardManifest(project, toolkitVersion));
  const files = new Map([
    ['index.html', landingPage(project)],
    ['ard.json', manifest],
    // Root-domain discovery. ARD v0.91 uses ard.json; the predecessor path is still read by some tools.
    ['.well-known/ard.json', manifest],
    ['.well-known/ai-catalog.json', manifest],
    ['mcp/server-card.json', json(serverCard(project, toolkitVersion))],
    ['SKILL.md', skillMd(project, toolkitVersion)],
    ['business.jsonld', json(jsonLd(project))],
    ['badge.svg', badgeSvg({ businessName: project.business.name, link: baseUrl(project) })],
  ]);
  if (project.a2a?.url) files.set('.well-known/agent-card.json', json(agentCard(project, toolkitVersion)));
  return files;
}

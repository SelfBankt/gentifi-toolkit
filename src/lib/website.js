import { baseUrl } from './project.js';

/**
 * Structured data for a business's own website, and a check of what's there.
 *
 * Search engines and AI search mostly trust the business's own site, so the
 * snippet goes there. It carries only details that rarely change (name,
 * address, hours, contact) and points to the Gentifi page for products and
 * prices, so it never goes stale when a price changes.
 */

const LOCAL_TYPES = /LocalBusiness|Store|Shop|Bakery|Restaurant|Cafe|CafeOrCoffeeShop|FoodEstablishment|Organization/;

export function websiteJsonLd(project) {
  const b = project.business;
  const base = baseUrl(project);
  const a = b.address ?? {};
  const hasAddress = a.street || a.locality || a.postcode;
  return {
    '@context': 'https://schema.org',
    '@type': b.schemaType || 'LocalBusiness',
    name: b.name,
    ...(b.description ? { description: b.description } : {}),
    ...(b.website ? { url: b.website } : {}),
    ...(b.telephone ? { telephone: b.telephone } : {}),
    ...(b.email ? { email: b.email } : {}),
    ...(hasAddress ? { address: { '@type': 'PostalAddress', streetAddress: a.street || undefined, addressLocality: a.locality || undefined, postalCode: a.postcode || undefined, addressCountry: 'GB' } } : {}),
    ...(b.openingHours?.length ? { openingHours: b.openingHours } : {}),
    hasOfferCatalog: { '@type': 'OfferCatalog', name: `${b.name}: products and prices`, url: `${base}/` },
  };
}

/** The block a business pastes once into its website's <head>. */
export function websiteSnippet(project) {
  const base = baseUrl(project);
  return [
    `<!-- Gentifi: ${project.business.name}'s details for search engines and AI assistants. Paste once into your website's <head>. -->`,
    `<link rel="ard" href="${base}/ard.json">`,
    '<script type="application/ld+json">',
    JSON.stringify(websiteJsonLd(project), null, 2).replace(/</g, '\\u003c'),
    '</script>',
  ].join('\n');
}

/** Every JSON-LD object on a page, with @graph and arrays flattened. */
export function pageJsonLd(html) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    found.push(v);
    if (v['@graph']) walk(v['@graph']);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]));
    } catch {
      found.push({ '@invalid': true });
    }
  }
  return found;
}

const digits = (s) => String(s ?? '').replace(/\D/g, '').replace(/^44/, '0');
const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hoursSet = (h) => new Set([h ?? []].flat().map((x) => String(x).replace(/\s+/g, ' ').trim()));

/** Which AI search crawlers robots.txt shuts out of the whole site. */
export function blockedCrawlers(robots, agents = ['Googlebot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Bingbot']) {
  const groups = [];
  let current = null;
  for (const raw of String(robots ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(m[2].toLowerCase());
    } else if (current) {
      current.rules.push({ allow: key === 'allow', path: m[2] });
    }
  }
  const rulesFor = (agent) => (groups.find((g) => g.agents.includes(agent.toLowerCase())) ?? groups.find((g) => g.agents.includes('*')))?.rules ?? [];
  return agents.filter((agent) => {
    const rules = rulesFor(agent);
    return rules.some((r) => !r.allow && r.path === '/') && !rules.some((r) => r.allow && (r.path === '/' || r.path === ''));
  });
}

/** Compares a website's structured data and robots.txt with the business's Gentifi data. */
export function checkWebsite(project, { html, robots }) {
  const b = project.business;
  const results = [];
  const add = (level, text) => results.push({ group: 'Your website', level, text });
  const objects = pageJsonLd(html);
  if (objects.some((o) => o['@invalid'])) add('warn', 'Some structured data on the page is broken JSON, so search engines ignore it.');
  const business = objects.find((o) => LOCAL_TYPES.test([o['@type']].flat().join(' ')) && o.name);
  if (!business) {
    add('fail', 'No structured data describing the business. Paste the Gentifi snippet into the page\'s <head>.');
  } else {
    const types = [business['@type']].flat().join(', ');
    if (/^Organization$/.test(types)) add('warn', 'The structured data describes a company (Organization), not a shop: AI can\'t read the address or opening hours as a local business. The Gentifi snippet marks it up as one.');
    else add('pass', `Structured data describes the business (${types}).`);
    if (!business.address) add('warn', 'No address in the structured data.');
    if (!business.openingHours && !business.openingHoursSpecification) add('warn', 'No opening hours in the structured data.');
    if (words(business.name) !== words(b.name)) add('warn', `Name is "${business.name}", but Gentifi has "${b.name}". Use one name everywhere.`);
    if (b.telephone && digits(business.telephone) !== digits(b.telephone)) add('warn', business.telephone ? `Phone number differs: ${business.telephone} on the site, ${b.telephone} on Gentifi.` : 'No phone number in the structured data.');
    const postcode = [business.address].flat()[0]?.postalCode;
    if (b.address?.postcode && postcode && words(postcode) !== words(b.address.postcode)) add('warn', `Postcode differs: ${postcode} on the site, ${b.address.postcode} on Gentifi.`);
    const siteHours = hoursSet(business.openingHours);
    const ourHours = hoursSet(b.openingHours);
    if (ourHours.size && (siteHours.size !== ourHours.size || [...ourHours].some((h) => !siteHours.has(h)))) {
      if (siteHours.size) add('warn', 'Opening hours differ from Gentifi: update the snippet.');
    }
  }
  if (/<link[^>]+rel=["']?ard["']?/i.test(html)) add('pass', 'The page links its AI discovery file (rel="ard").');
  else add('warn', 'The page doesn\'t link its AI discovery file. The Gentifi snippet adds it.');
  if (robots !== undefined) {
    const blocked = blockedCrawlers(robots);
    if (blocked.length) add('fail', `robots.txt blocks ${blocked.join(', ')}, so those search engines and AI assistants can't read the site.`);
    else add('pass', 'robots.txt lets Google, Bing, ChatGPT, Claude and Perplexity search read the site.');
  }
  return results;
}

/** What to check by hand on the business's Google Business Profile, which AI answers about local places lean on. */
export function googleProfileChecklist(project) {
  const b = project.business;
  const group = 'Google Business Profile (check by hand at business.google.com)';
  return [
    `The name is exactly "${b.name}".`,
    b.openingHours?.length ? `Opening hours match: ${b.openingHours.join('; ')}, with holiday hours added.` : 'Opening hours are filled in, with holiday hours.',
    'The primary category describes the business (for example Bakery, not just Store).',
    b.website ? `The website link is ${b.website}.` : 'The website link points to the business\'s own site.',
    'Products or a menu are listed, with photos.',
    b.telephone ? `The phone number is ${b.telephone}.` : 'The phone number is current.',
  ].map((text) => ({ group, level: 'info', text }));
}

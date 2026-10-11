import { COLLECTIONS_NS } from './outputs.js';
import { URN } from './validate.js';

/**
 * Collections draft 0.2 (github.com/SelfBankt/collections-spec): a collection
 * is an ARD manifest whose entries are its members, plus a "collection" object.
 * This module validates documents and verifies membership (rule 1).
 */

export const COLLECTION_TYPE = 'application/ai-collection+json';
export const KINDS = ['event', 'place', 'association', 'marketplace'];
export { COLLECTIONS_NS };

// Field names that hold data about people. Business details (names, addresses) are fine.
const PERSONAL = /^([a-z][\w-]*:)?(e-?mails?|phones?|telephone|mobile|customers?|attendees?|visitors?|guests?|delegates?|contacts?)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isHttps = (v) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Keys anywhere in the document that look like personal data (rule 2). */
function personalKeys(value, path = '', out = []) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const here = Array.isArray(value) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
      if (PERSONAL.test(k)) out.push(here);
      personalKeys(v, here, out);
    }
  }
  return out;
}

function urnPublisher(identifier) {
  return URN.exec(identifier ?? '')?.[1]?.toLowerCase() ?? null;
}

/**
 * Checks a collection document against draft 0.2.
 * @param {object} doc
 * @param {{ servedFrom?: string }} [options] URL the document was fetched from, to check the publisher's domain
 * @returns {Array<{ level: 'pass'|'warn'|'fail'|'info', text: string }>}
 */
export function validateCollection(doc, { servedFrom } = {}) {
  const r = [];
  const add = (level, text) => r.push({ level, text });
  const c = doc?.collection;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    if (Array.isArray(doc?.collection?.members) || Array.isArray(doc?.members)) add('fail', 'This looks like a draft 0.1 collection. In 0.2, members are ARD "entries" next to the "collection" object');
    else add('fail', 'A collection document needs a "collection" object and an "entries" list');
    return r;
  }

  const idPublisher = urnPublisher(c.id);
  if (!idPublisher || !/:collection:/.test(c.id)) add('fail', 'collection.id must be a URN like urn:air:<publisher-domain>:collection:<name>');
  else add('pass', `id ${c.id}`);
  if (typeof c.name === 'string' && c.name.trim()) add('pass', `name "${c.name}"`);
  else add('fail', 'collection.name is required');
  if (KINDS.includes(c.kind)) add('pass', `kind "${c.kind}"`);
  else add('fail', `collection.kind must be one of: ${KINDS.join(', ')}`);

  const domain = c.publisher?.domain?.toLowerCase();
  if (!c.publisher?.name || !domain || !domain.includes('.')) add('fail', 'collection.publisher needs a name and the domain it publishes from');
  else {
    add('pass', `publisher ${c.publisher.name} (${domain})`);
    if (idPublisher && idPublisher !== domain) add('fail', `collection.id names ${idPublisher} but the publisher's domain is ${domain}`);
    if (servedFrom) {
      const host = new URL(servedFrom).hostname.toLowerCase();
      if (host !== domain) add('fail', `Served from ${host}, not the publisher's domain ${domain}`);
      else add('pass', 'Served from the publisher\'s own domain');
    }
  }

  for (const k of ['validFrom', 'validTo']) {
    if (c[k] !== undefined && !(DATE.test(c[k]) && !Number.isNaN(Date.parse(c[k])))) add('fail', `collection.${k} must be a date like 2027-05-14`);
  }
  if (c.kind === 'event' && (!c.validFrom || !c.validTo)) add('warn', 'Events should give validFrom and validTo');
  else if (DATE.test(c.validFrom ?? '') && DATE.test(c.validTo ?? '')) {
    add(c.validFrom <= c.validTo ? 'pass' : 'fail', c.validFrom <= c.validTo ? `Runs ${c.validFrom} to ${c.validTo}` : 'validFrom must be on or before validTo');
  }
  if (c.area !== undefined) {
    const a = c.area;
    if (a.country !== undefined && !/^[A-Z]{2}$/.test(a.country)) add('fail', 'area.country must be a two-letter country code such as GB');
    if (a.postalCodes !== undefined && !(Array.isArray(a.postalCodes) && a.postalCodes.every((p) => typeof p === 'string' && p.trim()))) add('fail', 'area.postalCodes must be a list of postal code prefixes such as "BS1"');
    if (a.boundary !== undefined && !isHttps(a.boundary)) add('fail', 'area.boundary must be an https URL of a GeoJSON file');
  }
  if (c.facets !== undefined) {
    const ok = Array.isArray(c.facets) && c.facets.every((f) => typeof f === 'string' && (/^[A-Za-z][\w-]*:[A-Za-z][\w-]*$/.test(f) || f === 'capabilities' || f === 'tags'));
    if (!ok) add('fail', 'facets must be namespaced term names such as "col:category" (or "capabilities", "tags")');
  }

  const entries = doc.entries;
  if (!Array.isArray(entries) || !entries.length) {
    add('fail', 'entries must list at least one member');
  } else {
    const problems = [];
    const ids = new Set();
    entries.forEach((e, i) => {
      const label = e?.displayName ?? `entry ${i + 1}`;
      if (!URN.test(e?.identifier ?? '')) problems.push(`${label}: identifier must be urn:air:<domain>:<namespace>:<name>`);
      else if (ids.has(e.identifier)) problems.push(`${label}: identifier ${e.identifier} is listed twice`);
      else ids.add(e.identifier);
      if (!e?.displayName) problems.push(`entry ${i + 1}: displayName is required`);
      if (!e?.type) problems.push(`${label}: type (a media type) is required`);
      if ((typeof e?.url === 'string') === (e?.data !== undefined)) problems.push(`${label}: needs exactly one of url or data`);
      else if (e?.url !== undefined && !isHttps(e.url)) problems.push(`${label}: url must be https`);
      if (e?.['col:manifest'] !== undefined) {
        if (!isHttps(e['col:manifest'])) problems.push(`${label}: col:manifest must be an https URL`);
        else if (new URL(e['col:manifest']).hostname.toLowerCase() !== urnPublisher(e.identifier)) {
          problems.push(`${label}: col:manifest must be on ${urnPublisher(e.identifier)}, the domain in its identifier`);
        }
      }
      const usesCol = Object.keys(e ?? {}).some((k) => k.startsWith('col:'));
      if (usesCol && !JSON.stringify(e['@context'] ?? '').includes(COLLECTIONS_NS)) {
        problems.push(`${label}: uses col: terms, so its @context should bind col to ${COLLECTIONS_NS}`);
      }
      const p = e?.['col:priceFrom'];
      if (p !== undefined && !(typeof p?.amount === 'number' && p.amount >= 0 && /^[A-Z]{3}$/.test(p?.currency ?? ''))) {
        problems.push(`${label}: col:priceFrom needs an amount and a currency code`);
      }
    });
    if (problems.length) problems.forEach((p) => add('fail', p));
    else add('pass', `${entries.length} member${entries.length === 1 ? '' : 's'}, each pointing to its own resources`);
    const nested = entries.filter((e) => e?.type === COLLECTION_TYPE).length;
    if (nested) add('info', `${nested} nested collection${nested === 1 ? '' : 's'} (rule 4)`);
    if (entries.length > 5000) add('warn', 'More than 5,000 members: split into nested collections');
  }

  const personal = personalKeys(doc);
  add(personal.length ? 'fail' : 'pass', personal.length
    ? `Rule 2: a collection holds no customer data. Remove ${personal.join(', ')}`
    : 'Rule 2: no customer data');
  return r;
}

/** Where to find a member's own manifest: col:manifest, or the well-known path on its URN domain. */
export function memberManifestUrl(entry) {
  return entry['col:manifest'] ?? `https://${urnPublisher(entry.identifier)}/.well-known/ard.json`;
}

const sameUrl = (a, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

/**
 * Rule 1: a member counts only if its own manifest links back to this collection.
 * Nested collections confirm by listing the parent in collection.memberOf.
 * @returns {Promise<Array<{ entry: object, status: 'confirmed'|'unconfirmed'|'unreachable', detail: string }>>}
 */
export async function verifyMembership(doc, collectionUrl, { fetchImpl = globalThis.fetch, concurrency = 8 } = {}) {
  const getJson = async (url) => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const links = (list) => (Array.isArray(list) ? list : []).some((l) => sameUrl(l?.collection, collectionUrl));

  const verifyOne = async (entry) => {
    if (entry.type === COLLECTION_TYPE) {
      try {
        const nested = await getJson(entry.url);
        return links(nested?.collection?.memberOf)
          ? { entry, status: 'confirmed', detail: 'the nested collection lists this one in memberOf' }
          : { entry, status: 'unconfirmed', detail: 'the nested collection does not list this one in memberOf' };
      } catch (e) {
        return { entry, status: 'unreachable', detail: `${entry.url}: ${e.message}` };
      }
    }
    const url = memberManifestUrl(entry);
    const owner = urnPublisher(entry.identifier);
    if (new URL(url).hostname.toLowerCase() !== owner) {
      return { entry, status: 'unconfirmed', detail: `${url} is not on ${owner}, the member's own domain` };
    }
    let manifest;
    try {
      manifest = await getJson(url);
    } catch (e) {
      return { entry, status: 'unreachable', detail: `${url}: ${e.message}` };
    }
    const own = (manifest?.entries ?? []).find((x) => x?.identifier === entry.identifier);
    if (!own) return { entry, status: 'unconfirmed', detail: `${url} has no entry ${entry.identifier}` };
    return links(own['col:memberOf'])
      ? { entry, status: 'confirmed', detail: `${url} links back` }
      : { entry, status: 'unconfirmed', detail: `${url} does not list this collection in col:memberOf` };
  };

  const entries = doc.entries ?? [];
  const results = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      results[i] = await verifyOne(entries[i]);
    }
  }));
  return results;
}

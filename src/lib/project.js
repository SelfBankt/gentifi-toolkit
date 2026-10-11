import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PROJECT_FILE = 'gentifi.json';
export const PROJECT_VERSION = 1;
export const ORDER_METHODS = ['checkout', 'booking', 'reserve', 'quote'];

/** Local address used until the business sets where its files will live. */
export const LOCAL_BASE_URL = 'http://localhost:8787';

export class ProjectError extends Error {}

export function projectPath(values = {}) {
  return resolve(values.project ?? PROJECT_FILE);
}

export async function loadProject(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new ProjectError(`No ${PROJECT_FILE} found at ${path}. Run "gentifi init" first.`);
    throw e;
  }
  let project;
  try {
    project = JSON.parse(text);
  } catch (e) {
    throw new ProjectError(`${path} is not valid JSON: ${e.message}`);
  }
  if (project?.version !== PROJECT_VERSION || typeof project.business !== 'object' || !Array.isArray(project.catalogue?.items)) {
    throw new ProjectError(`${path} is not a gentifi.json project (version ${PROJECT_VERSION}).`);
  }
  return project;
}

export async function saveProject(path, project) {
  await writeFile(path, JSON.stringify(project, null, 2) + '\n');
}

/**
 * Lower-case letters, numbers and single hyphens, at most 64 characters:
 * valid as an Agent Skills name and as a URL path segment.
 */
export function slugify(text, max = 64) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}

/** Builds a new project from business details and imported items. */
export function createProject({ business, ordering, items, source, baseUrl, now = new Date() }) {
  const slug = business.slug || slugify(business.name);
  return {
    version: PROJECT_VERSION,
    business: {
      name: business.name,
      slug,
      kind: business.kind ?? '',
      description: business.description ?? '',
      website: business.website ?? '',
      telephone: business.telephone ?? '',
      email: business.email ?? '',
      address: { street: '', locality: '', postcode: '' },
      area: business.area ?? '',
      openingHours: business.openingHours ?? [],
      currency: business.currency ?? 'GBP',
    },
    ordering: {
      method: ordering.method ?? null,
      checkoutUrl: ordering.checkoutUrl ?? '',
      bookingUrl: ordering.bookingUrl ?? '',
      notes: ordering.notes ?? '',
    },
    catalogue: {
      source,
      updatedAt: now.toISOString(),
      items,
    },
    publish: {
      baseUrl: (baseUrl || LOCAL_BASE_URL).replace(/\/+$/, ''),
      mcpUrl: '',
    },
    memberOf: [],
    a2a: null,
  };
}

/** Picks the ordering method from what the business gave us, unless it chose one. */
export function inferOrderMethod({ method, checkoutUrl, bookingUrl, email, telephone }) {
  if (method) return method;
  if (checkoutUrl) return 'checkout';
  if (bookingUrl) return 'booking';
  if (email || telephone) return 'reserve';
  return null;
}

export function baseUrl(project) {
  return (project.publish?.baseUrl || LOCAL_BASE_URL).replace(/\/+$/, '');
}

export function mcpUrl(project) {
  return project.publish?.mcpUrl || `${baseUrl(project)}/mcp`;
}

/** The domain that publishes the files, used as the ARD URN publisher. */
export function publisherHost(project) {
  return new URL(baseUrl(project)).hostname;
}

export function isLocalUrl(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

// Money is held in minor units (pence) for arithmetic and formatted with Intl.

export function toMinor(amount) {
  return Math.round(Number(amount) * 100);
}

export function formatMoney(minor, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
}

/** "£3.20 per box", "from £540.00 per m²" */
export function describePrice(item, currency = 'GBP') {
  if (item.price != null) return `${formatMoney(toMinor(item.price), currency)}${item.unit ? ` per ${item.unit}` : ''}`;
  if (item.priceFrom != null) return `from ${formatMoney(toMinor(item.priceFrom), currency)}${item.unit ? ` per ${item.unit}` : ''}`;
  return 'price on request';
}

/** true / false when stock is known, null when the catalogue doesn't say. */
export function inStock(item, quantity = 1) {
  if (typeof item.stock === 'number') return item.stock >= quantity;
  if (typeof item.inStock === 'boolean') return item.inStock;
  return null;
}

const DAYS = { Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' };

/** "Tu-Sa 09:00-17:00" -> "Tuesday to Saturday, 09:00 to 17:00". Anything else is shown as written. */
export function humanHours(spec) {
  const m = /^\s*(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(spec ?? '');
  if (!m) return spec;
  const days = m[2] ? `${DAYS[m[1]]} to ${DAYS[m[2]]}` : DAYS[m[1]];
  return `${days}, ${m[3]} to ${m[4]}`;
}


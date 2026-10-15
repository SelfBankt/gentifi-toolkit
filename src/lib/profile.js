import { toMinor } from './project.js';

/**
 * A project as a Gentifi Business Profile, draft 0.1
 * (https://gentifi.com/standards/profile-0.1.schema.json, github.com/SelfBankt/gentifi-profile).
 *
 * The profile says how sure an agent can be of each fact. A spreadsheet only tells
 * us when the catalogue last changed, so every stock record is "likely", from the
 * owner, as of that time: honest, and stale after a day. Items with no stock given
 * have no availability record rather than a guessed one.
 */

export const PROFILE_SCHEMA = 'https://gentifi.com/standards/profile-0.1.schema.json';
const DAY_CODES = { Mo: 'mon', Tu: 'tue', We: 'wed', Th: 'thu', Fr: 'fri', Sa: 'sat', Su: 'sun' };
const WEEK = Object.keys(DAY_CODES);
// Gentifi doesn't record how fast a business replies yet; a day is the honest ceiling
const DEFAULT_REPLY_MINUTES = 24 * 60;

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null
  && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));

/** "gtf_" plus 8 to 32 letters and digits, from the business slug. */
export function profileBusinessId(slug) {
  const core = String(slug).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  return `gtf_${core.padEnd(8, '0')}`;
}

/** "Mo-Fr 09:00-17:00" or "Sa,Su 10:00-14:00" -> { days, opens, closes }; null if not understood. */
export function openingHoursEntry(spec) {
  const m = /^\s*([A-Za-z,\s-]+?)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(spec ?? '');
  if (!m) return null;
  const days = [];
  for (const part of m[1].split(',').map((p) => p.trim()).filter(Boolean)) {
    const [from, to] = part.split('-').map((d) => d.trim().slice(0, 2));
    if (!(from in DAY_CODES) || (to && !(to in DAY_CODES))) return null;
    const a = WEEK.indexOf(from);
    const b = to ? WEEK.indexOf(to) : a;
    for (let i = a; ; i = (i + 1) % 7) {
      if (!days.includes(DAY_CODES[WEEK[i]])) days.push(DAY_CODES[WEEK[i]]);
      if (i === b) break;
    }
  }
  return { days, opens: m[2], closes: m[3] };
}

const offeringId = (sku) => String(sku).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').padEnd(3, '0').slice(0, 64);

function price(item, currency) {
  const per = item.unit || undefined;
  if (item.price != null) return compact({ type: 'fixed', amount: { amount_minor: toMinor(item.price), currency }, per });
  if (item.priceFrom != null) return compact({ type: 'from', amount: { amount_minor: toMinor(item.priceFrom), currency }, per });
  return { type: 'quote' };
}

function stockRecord(item, id, freshness) {
  if (typeof item.stock === 'number') {
    return { type: 'stock', offering_id: id, status: item.stock > 0 ? 'in_stock' : 'out_of_stock', quantity: item.stock, ...(item.unit ? { quantity_unit: item.unit } : {}), freshness };
  }
  if (item.inStock === true || item.inStock === false) {
    return { type: 'stock', offering_id: id, status: item.inStock ? 'in_stock' : 'out_of_stock', freshness };
  }
  return null;
}

/** What customers' agents may do, from how the business takes orders today. */
function actions(project, ids) {
  const method = project.ordering?.method;
  const contact = ['name', 'contact'];
  const enquire = { action: 'enquire', mode: 'request_to_confirm', confirmation_sla_minutes: DEFAULT_REPLY_MINUTES, required_customer_fields: contact };
  if ((method === 'reserve' || method === 'checkout') && ids.length) {
    return [{ action: 'order', mode: 'request_to_confirm', applies_to: ids, confirmation_sla_minutes: DEFAULT_REPLY_MINUTES, required_customer_fields: contact }, enquire];
  }
  return [enquire];
}

export function businessProfile(project) {
  const b = project.business;
  const currency = b.currency || 'GBP';
  const asOf = project.catalogue.updatedAt;
  const freshness = { observed_at: asOf, confidence: 'likely', source: 'owner' };
  const used = new Set();
  const offerings = project.catalogue.items.map((item) => {
    let id = offeringId(item.sku);
    for (let n = 2; used.has(id); n++) id = `${offeringId(item.sku).slice(0, 60)}-${n}`;
    used.add(id);
    return {
      item,
      offering: compact({
        id,
        kind: item.kind === 'service' ? 'service' : 'product',
        name: item.name,
        description: item.description,
        price: price(item, item.currency || currency),
        fulfilment: ['collection'],
        attributes: compact({ category: item.category, allergens: item.allergens, dietary: item.dietary, availability: item.availability, order_notice: item.notice }),
      }),
    };
  });
  const a = b.address ?? {};
  return {
    spec_version: '0.1',
    business: compact({
      id: profileBusinessId(b.slug),
      name: b.name,
      description: b.description,
      categories: ['Store'],
      tags: [b.kind, b.area].filter(Boolean),
      location: { address: compact({ line1: a.street, locality: a.locality, postal_code: a.postcode, country: 'GB' }) },
      time_zone: 'Europe/London',
      opening_hours: (b.openingHours ?? []).map(openingHoursEntry).filter(Boolean),
      contact: compact({ phone: b.telephone, email: b.email, website: b.website }),
      verification: { status: 'unverified' },
    }),
    offerings: offerings.map((o) => o.offering),
    availability: offerings.map((o) => stockRecord(o.item, o.offering.id, freshness)).filter(Boolean),
    policies: {},
    actions: actions(project, offerings.filter((o) => o.offering.price.type !== 'quote').map((o) => o.offering.id)),
    updated_at: asOf,
    extensions: { 'com.gentifi': compact({ generator: 'gentifi-toolkit', schema: PROFILE_SCHEMA, page: project.publish?.baseUrl ? `${project.publish.baseUrl}/` : undefined, connector: project.publish?.networkUrl || undefined }) },
  };
}

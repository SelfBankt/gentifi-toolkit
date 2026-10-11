import { describePrice, formatMoney, humanHours, inStock, toMinor } from '../lib/project.js';

/**
 * The MCP tools for one business. Every tool is read-only: nothing here places
 * an order. prepare_order returns a summary and a link or message the customer
 * uses to confirm with the business themselves.
 */

export class ToolError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// --- Search ---

const STOP = new Set(('a an the and or of for to in on at is are be do does you your they them their have has got '
  + 'any some this that these those week today tomorrow me my i we us please can could would there what which who '
  + 'how much many where when price prices cost costs stock available availability buy order reserve book near from '
  + 'with get want need find shop store sell sells selling').split(' '));

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ves')) return w.slice(0, -3) + 'f';
  if (w.length > 3 && /(x|ch|sh|ss|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

function sameWord(a, b) {
  if (a === b || stem(a) === stem(b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
}

/** Scores items against a free-text query: matched words, with name matches counting double. */
export function searchItems(items, query) {
  const words = [...new Set(tokens(query))];
  if (!words.length) return items.map((item) => ({ item, score: 0 }));
  return items
    .map((item) => {
      const nameWords = tokens(item.name);
      const otherWords = tokens(`${item.category} ${item.description} ${item.sku}`);
      let score = 0;
      for (const w of words) {
        if (nameWords.some((t) => sameWord(w, t))) score += 2;
        else if (otherWords.some((t) => sameWord(w, t))) score += 1;
      }
      return { item, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
}

function findItem(items, ref) {
  const want = String(ref ?? '').trim().toLowerCase();
  if (!want) return null;
  return items.find((i) => i.sku.toLowerCase() === want)
    ?? items.find((i) => i.name.toLowerCase() === want)
    ?? searchItems(items, want)[0]?.item
    ?? null;
}

// --- Shapes returned to agents ---

function itemView(item, currency) {
  return {
    sku: item.sku,
    name: item.name,
    kind: item.kind,
    category: item.category || undefined,
    description: item.description || undefined,
    price: item.price ?? undefined,
    priceFrom: item.priceFrom ?? undefined,
    currency: item.currency || currency,
    priceText: describePrice(item, item.currency || currency),
    unit: item.unit || undefined,
    stock: item.stock ?? undefined,
    inStock: inStock(item) ?? undefined,
    availability: item.availability || undefined,
    url: item.url || undefined,
  };
}

function businessView(project) {
  const b = project.business;
  return {
    name: b.name,
    kind: b.kind || undefined,
    description: b.description || undefined,
    area: b.area || undefined,
    address: Object.values(b.address ?? {}).some(Boolean) ? b.address : undefined,
    openingHours: b.openingHours?.length ? b.openingHours.map(humanHours) : undefined,
    website: b.website || undefined,
    telephone: b.telephone || undefined,
    email: b.email || undefined,
    ordering: {
      method: project.ordering?.method ?? 'none',
      notes: project.ordering?.notes || undefined,
    },
    catalogueUpdatedAt: project.catalogue.updatedAt,
  };
}

// --- Ordering hand-off ---

function orderEmail(project, lines, total, { collectionDate, note }) {
  const b = project.business;
  const verb = project.ordering?.method === 'quote' ? 'a quote for' : 'to reserve';
  const body = [
    `Hello ${b.name},`,
    '',
    `I'd like ${verb}:`,
    ...lines.map((l) => `- ${l.quantity} x ${l.name} (${l.sku}) ${l.lineTotalText ?? l.priceText}`),
    total ? `Total: ${total.formatted}` : null,
    collectionDate ? `Collection or date: ${collectionDate}` : null,
    note ? `Note: ${note}` : null,
    '',
    `Prepared with my AI agent from your catalogue (prices as of ${project.catalogue.updatedAt.slice(0, 10)}). Please reply to confirm.`,
  ].filter((x) => x !== null).join('\n');
  const subject = `${project.ordering?.method === 'quote' ? 'Quote request' : 'Reservation request'}: ${lines.map((l) => l.name).join(', ')}`.slice(0, 120);
  return `mailto:${encodeURIComponent(b.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function nextStep(project, lines, total, extra) {
  const o = project.ordering ?? {};
  const b = project.business;
  const confirm = 'Show the customer this summary first. Only they can confirm it.';
  if (o.method === 'checkout' && (o.checkoutUrl || lines[0]?.url)) {
    let url = o.checkoutUrl || lines[0].url;
    if (lines.length === 1) {
      url = url.replace(/\{sku\}/g, encodeURIComponent(lines[0].sku)).replace(/\{quantity\}/g, String(lines[0].quantity));
    }
    return { type: 'link', label: 'Open the business’s checkout', url, instructions: `${confirm} They finish and pay on the business’s own checkout page.` };
  }
  if (o.method === 'booking' && o.bookingUrl) {
    return { type: 'link', label: 'Open the booking page', url: o.bookingUrl, instructions: `${confirm} They choose a time and book on the business’s own booking page.` };
  }
  if ((o.method === 'reserve' || o.method === 'quote') && b.email) {
    const what = o.method === 'quote' ? 'quote request' : 'reservation request';
    return { type: 'email', label: `Send the ${what}`, url: orderEmail(project, lines, total, extra), instructions: `${confirm} If they agree, they send the ${what} themselves with this link; ${b.name} replies to confirm.` };
  }
  if ((o.method === 'reserve' || o.method === 'quote') && b.telephone) {
    return { type: 'phone', label: `Call ${b.name}`, url: `tel:${b.telephone.replace(/[^\d+]/g, '')}`, instructions: `${confirm} They call ${b.name} to ${o.method === 'quote' ? 'ask for a quote' : 'reserve'}.` };
  }
  return {
    type: 'contact',
    label: `Contact ${b.name}`,
    url: b.website || undefined,
    instructions: `${b.name} hasn't set up ordering through agents yet. The customer can contact them directly.`,
  };
}

// --- Tool definitions ---

export function businessTools(project) {
  const items = project.catalogue.items;
  const currency = project.business.currency || 'GBP';
  const asOf = project.catalogue.updatedAt;
  const name = project.business.name;

  return [
    {
      name: 'get_business_info',
      title: `About ${name}`,
      description: `Opening hours, location, contact details and how ordering works at ${name}.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: { title: `About ${name}`, ...READ_ONLY },
      handler: () => businessView(project),
    },
    {
      name: 'search_catalogue',
      title: `Search ${name}`,
      description: `Search the products and services ${name} sells, with prices, stock and availability from the business's own catalogue. Leave query empty to list everything.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the customer is looking for, in their words, e.g. "eggs" or "sourdough"' },
          category: { type: 'string', description: 'Only items in this category' },
          max_price: { type: 'number', minimum: 0, description: `Only items at or under this price (${currency})` },
          in_stock_only: { type: 'boolean', description: 'Leave out items known to be out of stock' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most results to return (default 10)' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { items: { type: 'array' }, total: { type: 'integer' }, pricesAsOf: { type: 'string' } },
        required: ['items', 'total', 'pricesAsOf'],
      },
      annotations: { title: `Search ${name}`, ...READ_ONLY },
      handler: ({ query = '', category, max_price: maxPrice, in_stock_only: onlyInStock, limit = 10 }) => {
        let results = searchItems(items, query).map((r) => r.item);
        if (category) results = results.filter((i) => i.category.toLowerCase() === category.toLowerCase());
        if (maxPrice != null) results = results.filter((i) => (i.price ?? i.priceFrom) <= maxPrice);
        if (onlyInStock) results = results.filter((i) => inStock(i) !== false);
        return { items: results.slice(0, limit).map((i) => itemView(i, currency)), total: results.length, pricesAsOf: asOf };
      },
    },
    {
      name: 'check_availability',
      title: 'Check availability',
      description: `Check whether ${name} has enough of one item, and when it's available. Use the SKU from search_catalogue.`,
      inputSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU from search_catalogue (an item name also works)' },
          quantity: { type: 'integer', minimum: 1, description: 'How many the customer wants (default 1)' },
        },
        required: ['sku'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', properties: { sku: { type: 'string' }, available: { type: ['boolean', 'null'] } }, required: ['sku', 'available'] },
      annotations: { title: 'Check availability', ...READ_ONLY },
      handler: ({ sku, quantity = 1 }) => {
        const item = findItem(items, sku);
        if (!item) throw new ToolError(`No item matches "${sku}". Use search_catalogue to find the SKU.`);
        const available = inStock(item, quantity);
        let note;
        if (available === null) note = `${name}'s catalogue doesn't give a stock level for this item.`;
        else if (!available && typeof item.stock === 'number' && item.stock > 0) note = `Only ${item.stock} in stock.`;
        else if (!available) note = 'Out of stock.';
        return { ...itemView(item, currency), quantity, available, note, pricesAsOf: asOf };
      },
    },
    {
      name: 'prepare_order',
      title: 'Prepare an order for the customer to confirm',
      description: `Work out the items and total for an order or reservation at ${name}, with the link the customer uses to confirm it. Nothing is ordered or sent: show the customer the summary and let them decide.`,
      inputSchema: ORDER_ARGUMENTS,
      outputSchema: {
        type: 'object',
        properties: { status: { const: 'not_ordered' }, confirmationRequired: { const: true }, nextStep: { type: 'object' } },
        required: ['status', 'confirmationRequired', 'nextStep'],
      },
      annotations: { title: 'Prepare an order for the customer to confirm', ...READ_ONLY },
      handler: ({ items: wanted, collection_date: collectionDate, note }) => {
        const { lines, total, warnings, summary } = priceOrder(items, wanted, currency);
        return {
          status: 'not_ordered',
          confirmationRequired: true,
          business: name,
          summary,
          lines,
          total,
          collectionDate: collectionDate || undefined,
          warnings,
          nextStep: nextStep(project, lines, total, { collectionDate, note }),
          pricesAsOf: asOf,
        };
      },
    },
  ];
}

/** Arguments for an order: shared by prepare_order and pay_order, so both price the same way. */
export const ORDER_ARGUMENTS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU from search_catalogue' },
          quantity: { type: 'integer', minimum: 1 },
        },
        required: ['sku', 'quantity'],
        additionalProperties: false,
      },
    },
    collection_date: { type: 'string', description: 'When the customer wants to collect or receive it, in their words' },
    note: { type: 'string', maxLength: 500, description: 'Anything the customer wants to tell the business' },
  },
  required: ['items'],
  additionalProperties: false,
};

/**
 * Prices an order from the catalogue: lines, total in minor units, and
 * warnings for shortages or items priced on request.
 */
export function priceOrder(items, wanted, currency) {
  const warnings = [];
  const short = [];
  let totalMinor = 0;
  let priced = true;
  const lines = wanted.map(({ sku, quantity }) => {
    const item = findItem(items, sku);
    if (!item) throw new ToolError(`No item matches "${sku}". Use search_catalogue to find the SKU.`);
    const available = inStock(item, quantity);
    if (available === false) {
      short.push(item.name);
      warnings.push(typeof item.stock === 'number' && item.stock > 0
        ? `${item.name}: only ${item.stock} in stock, ${quantity} asked for.`
        : `${item.name}: out of stock.`);
    }
    const line = { sku: item.sku, name: item.name, quantity, priceText: describePrice(item, currency), available };
    if (item.price != null) {
      const lineMinor = toMinor(item.price) * quantity;
      totalMinor += lineMinor;
      line.unitPrice = item.price;
      line.lineTotal = lineMinor / 100;
      line.lineTotalText = formatMoney(lineMinor, currency);
    } else {
      priced = false;
      warnings.push(`${item.name}: ${line.priceText}; the business will confirm the price.`);
    }
    if (item.url) line.url = item.url;
    return line;
  });
  const total = priced ? { amount: totalMinor / 100, currency, formatted: formatMoney(totalMinor, currency) } : null;
  const summary = lines.map((l) => `${l.quantity} x ${l.name}${l.lineTotalText ? ` = ${l.lineTotalText}` : ''}`).join('; ')
    + (total ? `. Total ${total.formatted}.` : '.');
  return { lines, totalMinor, total, priced, short, warnings, summary };
}

// --- Argument validation (the JSON Schema subset the tools use) ---

export function validateArgs(schema, value, path = 'arguments') {
  const errors = [];
  const typeOk = (t, v) => (t === 'integer' ? Number.isInteger(v)
    : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : t === 'array' ? Array.isArray(v)
        : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
          : t === 'null' ? v === null
            : typeof v === t);
  const types = [schema.type].flat().filter(Boolean);
  if (types.length && !types.some((t) => typeOk(t, value))) {
    errors.push(`${path} should be ${types.join(' or ')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} should be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} should be at least ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} should be at most ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.maxLength != null && value.length > schema.maxLength) {
    errors.push(`${path} should be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateArgs(schema.items, v, `${path}[${i}]`)));
  }
  if (typeOk('object', value) && schema.properties) {
    for (const key of schema.required ?? []) if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties[key]) errors.push(...validateArgs(schema.properties[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known argument`);
    }
  }
  return errors;
}

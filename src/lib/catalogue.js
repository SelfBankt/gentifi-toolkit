import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCsv } from './csv.js';
import { slugify } from './project.js';

// Header names people actually use in spreadsheets, after normaliseHeader().
const COLUMNS = {
  sku: ['sku', 'id', 'code', 'product_code', 'item_code'],
  name: ['name', 'item', 'product', 'product_name', 'title'],
  price: ['price_gbp', 'price', 'unit_price', 'price_each', 'cost'],
  priceFrom: ['price_from_gbp', 'price_from', 'from_price', 'from'],
  currency: ['currency'],
  stock: ['stock', 'quantity', 'qty', 'inventory', 'in_stock', 'available_quantity'],
  unit: ['unit', 'per', 'size', 'pack'],
  availability: ['availability', 'available_from', 'available', 'when'],
  category: ['category', 'section', 'department', 'type'],
  description: ['description', 'details', 'notes'],
  kind: ['kind'],
  url: ['url', 'link', 'product_url'],
  allergens: ['allergens', 'allergen', 'contains', 'allergy_info', 'allergen_info'],
  dietary: ['dietary', 'diet', 'suitable_for', 'dietary_info'],
  notice: ['notice', 'order_notice', 'pre_order_notice', 'preorder_notice', 'lead_time', 'pre_order', 'preorder'],
};

const CURRENCY_FROM_HEADER = { price_gbp: 'GBP', price_from_gbp: 'GBP', price_eur: 'EUR', price_usd: 'USD' };

function pick(record, key) {
  for (const h of COLUMNS[key]) {
    if (record[h] !== undefined && record[h] !== '') return { header: h, value: record[h] };
  }
  return { header: null, value: '' };
}

/** "£1,250.00" -> 1250, "3.2" -> 3.2; null for blank, NaN for nonsense. */
export function parsePrice(text) {
  const cleaned = String(text).replace(/[£$€,\s]/g, '').replace(/^(gbp|eur|usd)/i, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/** Whole numbers become a count; yes/no style answers become a flag; blank is unknown. */
export function parseStock(text) {
  const t = String(text).trim().toLowerCase();
  if (t === '') return { stock: null, inStock: null };
  if (/^\d+$/.test(t)) return { stock: Number(t), inStock: Number(t) > 0 };
  if (['yes', 'y', 'true', 'in stock', 'available'].includes(t)) return { stock: null, inStock: true };
  if (['no', 'n', 'false', 'out of stock', 'sold out', 'none'].includes(t)) return { stock: 0, inStock: false };
  return { stock: undefined, inStock: null };
}

/**
 * Turns spreadsheet records into catalogue items. Rows that can't be used are
 * skipped and reported: the toolkit never guesses a price or a name.
 */
export function itemsFromRecords(records) {
  const items = [];
  const problems = [];
  const seen = new Set();

  for (const r of records) {
    const where = `row ${r._row}`;
    const name = pick(r, 'name').value;
    if (!name) {
      problems.push(`${where}: no name, skipped`);
      continue;
    }
    const priceCell = pick(r, 'price');
    const fromCell = pick(r, 'priceFrom');
    const price = parsePrice(priceCell.value);
    const priceFrom = parsePrice(fromCell.value);
    if (Number.isNaN(price) || Number.isNaN(priceFrom)) {
      problems.push(`${where} (${name}): price "${priceCell.value || fromCell.value}" is not a number, skipped`);
      continue;
    }
    if (price == null && priceFrom == null) {
      problems.push(`${where} (${name}): no price, skipped`);
      continue;
    }
    const stockCell = pick(r, 'stock').value;
    const { stock, inStock } = parseStock(stockCell);
    if (stock === undefined) {
      problems.push(`${where} (${name}): stock "${stockCell}" not understood, left as unknown`);
    }

    let sku = pick(r, 'sku').value || slugify(name).toUpperCase();
    if (seen.has(sku)) {
      let n = 2;
      while (seen.has(`${sku}-${n}`)) n++;
      problems.push(`${where} (${name}): SKU "${sku}" is used twice, renamed to "${sku}-${n}"`);
      sku = `${sku}-${n}`;
    }
    seen.add(sku);

    const kind = pick(r, 'kind').value.toLowerCase();
    const currency = pick(r, 'currency').value.toUpperCase()
      || CURRENCY_FROM_HEADER[priceCell.header ?? fromCell.header]
      || 'GBP';

    items.push({
      sku,
      name,
      kind: kind === 'service' ? 'service' : 'product',
      category: pick(r, 'category').value,
      description: pick(r, 'description').value,
      price: price ?? null,
      priceFrom: price == null ? priceFrom : null,
      currency,
      unit: pick(r, 'unit').value,
      stock: stock ?? null,
      inStock,
      availability: pick(r, 'availability').value,
      url: pick(r, 'url').value,
      allergens: pick(r, 'allergens').value,
      dietary: pick(r, 'dietary').value,
      notice: pick(r, 'notice').value,
    });
  }
  return { items, problems };
}

/** Reads a catalogue from a local CSV file or an http(s) URL (such as a published Google Sheet). */
export async function readSource(source, { fetchImpl = globalThis.fetch } = {}) {
  if (source.type !== 'csv') throw new Error(`Unsupported source type "${source.type}"`);
  let text;
  if (/^https?:\/\//i.test(source.file)) {
    const res = await fetchImpl(source.file, { headers: { accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' } });
    if (!res.ok) throw new Error(`Could not download ${source.file}: HTTP ${res.status}`);
    text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(`${source.file} returned a web page, not CSV. For a Google Sheet use File > Share > Publish to web > CSV.`);
    }
  } else {
    text = await readFile(resolve(source.file), 'utf8');
  }
  const { records } = parseCsv(text);
  return itemsFromRecords(records);
}

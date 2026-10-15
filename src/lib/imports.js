/**
 * Till and online-shop exports, turned into the plain records a spreadsheet
 * gives (name, sku, price, stock, category, description), so itemsFromRecords
 * checks them the same way. Each adapter takes records keyed by normalised
 * header and returns { records, problems }. Live connections to the same
 * systems can reuse these mappings later.
 */

const stripHtml = (s = '') => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const yes = (s = '') => /^(y|yes|true|1)$/i.test(s.trim());
const no = (s = '') => /^(n|no|false|0)$/i.test(s.trim());

/** Adds up the whole-number cells in columns whose header starts with prefix; '' when none. */
function sumColumns(record, prefix) {
  const values = Object.keys(record).filter((k) => k.startsWith(prefix)).map((k) => record[k]).filter((v) => /^-?\d+(\.0+)?$/.test(v ?? ''));
  return values.length ? String(Math.max(0, values.reduce((t, v) => t + Math.trunc(Number(v)), 0))) : '';
}

/**
 * Square: Items > Export library (.xlsx or .csv). One row per variation, with
 * "Current Quantity <location>" columns per location.
 */
function square(records) {
  const problems = [];
  const out = [];
  for (const r of records) {
    const item = r.item_name ?? '';
    if (!item) continue;
    if (yes(r.archived)) continue;
    if (no(r.sellable)) continue;
    const variation = r.variation_name ?? '';
    const name = variation && !/^regular$/i.test(variation) ? `${item} (${variation})` : item;
    // A single-location export has "Price"; some name the location: "Price Hobbs House"
    let price = r.price ?? r[Object.keys(r).find((k) => k.startsWith('price_')) ?? ''] ?? '';
    if (/^variable$/i.test(price)) {
      problems.push(`row ${r._row} (${name}): Square has a variable price, skipped. Add it to a sheet with a price, or set one in Square.`);
      continue;
    }
    out.push({
      _row: r._row,
      name,
      sku: r.sku ?? '',
      price,
      stock: sumColumns(r, 'current_quantity'),
      category: r.reporting_category || r.categories || r.category || '',
      description: stripHtml(r.description),
    });
  }
  return { records: out, problems };
}

/**
 * Shopify: Products > Export (.csv). One row per variant; extra variant and
 * image rows repeat the Handle with the product columns left blank.
 */
function shopify(records) {
  const out = [];
  const products = new Map();
  for (const r of records) {
    const handle = r.handle ?? '';
    if (!handle) continue;
    if (r.title) products.set(handle, r);
    const product = products.get(handle) ?? r;
    if (!r.variant_price) continue; // an image-only row
    const status = (product.status ?? '').toLowerCase();
    if (status === 'draft' || status === 'archived' || (status === '' && no(product.published))) continue;
    const options = [r.option1_value, r.option2_value, r.option3_value].filter((v) => v && v !== 'Default Title');
    const name = options.length ? `${product.title} (${options.join(', ')})` : product.title;
    if (!name) continue;
    const category = (product.product_category ?? '').split('>').pop().trim() || product.type || '';
    out.push({
      _row: r._row,
      name,
      sku: r.variant_sku ?? '',
      price: r.variant_price,
      stock: r.variant_inventory_qty ?? '',
      category,
      description: stripHtml(product.body_html),
    });
  }
  return { records: out, problems: [] };
}

/**
 * WooCommerce: Products > Export (.csv). Variable products are a parent row
 * without a price, followed by one "variation" row each.
 */
function woocommerce(records) {
  const out = [];
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    const type = (r.type ?? 'simple').toLowerCase();
    if (type.includes('variable') || type.includes('grouped') || type.includes('external')) continue;
    if (r.published !== undefined && r.published !== '' && r.published !== '1') continue;
    const parent = type.includes('variation') ? byId.get((r.parent ?? '').replace(/^id:/, '')) : null;
    let name = r.name || parent?.name || '';
    if (type.includes('variation') && !r.name) {
      const values = Object.keys(r).filter((k) => /^attribute_\d+_value_s$/.test(k)).map((k) => r[k]).filter(Boolean);
      if (values.length) name = `${name} (${values.join(', ')})`;
    }
    if (!name) continue;
    const stock = r.stock !== undefined && r.stock !== '' ? r.stock : r.in_stock === '1' ? 'yes' : r.in_stock === '0' ? 'no' : (r.in_stock ?? '');
    out.push({
      _row: r._row,
      name,
      sku: r.sku ?? '',
      price: r.sale_price || r.regular_price || '',
      stock,
      category: (r.categories || parent?.categories || '').split(',')[0].split('>').pop().trim(),
      description: stripHtml(r.short_description || parent?.short_description || r.description || ''),
    });
  }
  return { records: out, problems: [] };
}

export const IMPORTERS = {
  square: { name: 'Square', export: 'Square Dashboard: Items > Item library > Actions > Export library', map: square },
  shopify: { name: 'Shopify', export: 'Shopify admin: Products > Export, as a plain CSV file', map: shopify },
  woocommerce: { name: 'WooCommerce', export: 'WordPress: Products > All Products > Export', map: woocommerce },
};

/** Headers that only appear in each system's export, so a mismatched file gets a clear message. */
const SIGNATURES = {
  square: (h) => h.includes('item_name') && h.includes('variation_name'),
  shopify: (h) => h.includes('handle') && h.includes('variant_price'),
  woocommerce: (h) => h.includes('regular_price') && h.includes('type'),
};

/** Which system a header row came from, or null for an ordinary spreadsheet. */
export function detectExport(headers) {
  return Object.keys(SIGNATURES).find((k) => SIGNATURES[k](headers)) ?? null;
}

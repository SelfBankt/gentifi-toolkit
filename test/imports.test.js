import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSource } from '../src/lib/catalogue.js';
import { readXlsxRows } from '../src/lib/xlsx.js';
import { main } from '../src/cli.js';
import { withTempDir } from './helpers.js';

/** A minimal .xlsx (stored, not deflated) with shared strings, numbers, an inline string and a gap. */
function xlsx(rows) {
  const strings = [];
  const ref = (r, c) => `${String.fromCharCode(65 + c)}${r + 1}`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheetRows = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => {
    if (v === null) return '';
    if (typeof v === 'number') return `<c r="${ref(r, c)}"><v>${v}</v></c>`;
    if (v.startsWith('inline:')) return `<c r="${ref(r, c)}" t="inlineStr"><is><t>${esc(v.slice(7))}</t></is></c>`;
    strings.push(v);
    return `<c r="${ref(r, c)}" t="s"><v>${strings.length - 1}</v></c>`;
  }).join('')}</row>`).join('');
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/items.xml"/></Relationships>',
    'xl/worksheets/items.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><r><t>${esc(s.slice(0, 2))}</t></r><r><t xml:space="preserve">${esc(s.slice(2))}</t></r></si>`).join('')}</sst>`,
  };
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]);
}

const SQUARE = [
  ['Token', 'Item Name', 'Variation Name', 'SKU', 'Description', 'Reporting Category', 'Price', 'Archived', 'Sellable', 'Current Quantity Hobbs House', 'New Quantity Hobbs House'],
  ['T1', 'Sourdough loaf', 'Regular', 'SD-1', '<p>Long ferment &amp; crusty</p>', 'Bread', 4.5, 'N', 'Y', 12, null],
  ['T2', 'Bloomer', 'Large', null, null, 'Bread', 3.8000000000000003, 'N', 'Y', 0, null],
  ['T3', 'Celebration cake', 'Regular', 'CK-1', null, 'Cakes', 'variable', 'N', 'Y', null, null],
  ['T4', 'Old scone', 'Regular', 'SC-1', null, 'Cakes', 2, 'Y', 'Y', 5, null],
  ['T5', 'inline:Flat white', 'Regular', 'FW-1', null, 'Drinks', 3.2, 'N', 'Y', null, null],
];

test('xlsx: shared strings in several runs, numbers, inline strings and gaps', () => {
  const rows = readXlsxRows(xlsx([['Name', 'Price', 'Note'], ['Eggs & ham', 3.2, null], ['inline:Bread', 4.4999999999999991, 'x']]));
  assert.deepEqual(rows, [['Name', 'Price', 'Note'], ['Eggs & ham', '3.2', ''], ['Bread', '4.5', 'x']]);
});

test('Square export: one item per variation, archived and variable prices left out', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'square.xlsx');
    await writeFile(file, xlsx(SQUARE));
    const { items, problems } = await readSource({ type: 'square', file });
    assert.deepEqual(items.map((i) => [i.name, i.sku, i.price, i.stock, i.category]), [
      ['Sourdough loaf', 'SD-1', 4.5, 12, 'Bread'],
      ['Bloomer (Large)', 'BLOOMER-LARGE', 3.8, 0, 'Bread'],
      ['Flat white', 'FW-1', 3.2, null, 'Drinks'],
    ]);
    assert.equal(items[0].description, 'Long ferment & crusty');
    assert.equal(items[1].inStock, false);
    assert.match(problems.join('\n'), /Celebration cake\): Square has a variable price/);
    // The same export saved as CSV reads the same, and a plain "csv" source spots it
    const csv = join(dir, 'square.csv');
    await writeFile(csv, readXlsxRows(xlsx(SQUARE)).map((r) => r.map((c) => `"${c}"`).join(',')).join('\n'));
    assert.deepEqual((await readSource({ type: 'csv', file: csv })).items.map((i) => i.name), items.map((i) => i.name));
  });
});

test('Shopify export: variants named by option, image rows and drafts left out', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'products_export.csv');
    await writeFile(file, [
      'Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Variant Inventory Qty,Variant Price,Image Src,Status',
      'sourdough,Sourdough loaf,<p>Our classic</p>,Bakery,Food > Bakery > Bread,Bread,,true,Title,Default Title,,,SD-1,8,4.50,https://cdn.example/sd.jpg,active',
      'sourdough,,,,,,,,,,,,,,,https://cdn.example/sd2.jpg,',
      'jam,Strawberry jam,,Farm,,Preserves,,true,Size,Small,,,JAM-S,3,3.00,,active',
      'jam,,,,,,,,,Large,,,JAM-L,0,5.00,,',
      'secret,New pie,,Bakery,,Pies,,false,Title,Default Title,,,PIE-1,4,6.00,,draft',
    ].join('\n'));
    const { items } = await readSource({ type: 'shopify', file });
    assert.deepEqual(items.map((i) => [i.name, i.sku, i.price, i.stock, i.category]), [
      ['Sourdough loaf', 'SD-1', 4.5, 8, 'Bread'],
      ['Strawberry jam (Small)', 'JAM-S', 3, 3, 'Preserves'],
      ['Strawberry jam (Large)', 'JAM-L', 5, 0, 'Preserves'],
    ]);
    assert.equal(items[0].description, 'Our classic');
  });
});

test('WooCommerce export: variations named from their parent, sale prices, private items left out', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'wc-product-export.csv');
    await writeFile(file, [
      'ID,Type,SKU,Name,Published,"Is featured?","Short description",Description,"In stock?",Stock,"Sale price","Regular price",Categories,Parent,"Attribute 1 name","Attribute 1 value(s)"',
      '10,simple,EGG-12,Free-range eggs,1,0,Dozen,,1,,,3.20,Eggs > Free range,,,',
      '11,variable,HOOD,Farm hoodie,1,0,Warm,,1,,,,Clothing,,Size,"S, M"',
      '12,variation,HOOD-S,,1,0,,,1,4,,25.00,,id:11,Size,S',
      '13,variation,HOOD-M,,1,0,,,0,0,20.00,25.00,,id:11,Size,M',
      '14,simple,STAFF,Staff discount card,-1,0,,,1,,,1.00,,,,',
    ].join('\n'));
    const { items } = await readSource({ type: 'woocommerce', file });
    assert.deepEqual(items.map((i) => [i.name, i.sku, i.price, i.stock, i.inStock, i.category]), [
      ['Free-range eggs', 'EGG-12', 3.2, null, true, 'Free range'],
      ['Farm hoodie (S)', 'HOOD-S', 25, 4, true, 'Clothing'],
      ['Farm hoodie (M)', 'HOOD-M', 20, 0, false, 'Clothing'],
    ]);
  });
});

test('the wrong export for the chosen system says where to export it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'sheet.csv');
    await writeFile(file, 'name,price\nEggs,3.20\n');
    await assert.rejects(readSource({ type: 'shopify', file }), /doesn't look like a Shopify product export\. Export it from Shopify admin: Products > Export/);
  });
});

test('init --from square creates a project from a Square export', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'square.xlsx');
    await writeFile(file, xlsx(SQUARE));
    const out = [];
    const err = [];
    const code = await main(['init', '--from', 'square', '--file', file, '--name', 'Corner Bakery', '--project', join(dir, 'gentifi.json')], { out: (s) => out.push(s), err: (s) => err.push(s) });
    assert.equal(code, 0, err.join('\n'));
    assert.match(out.join('\n'), /3 items/);
    assert.match(out.join('\n'), /variable price/);
    const missing = [];
    assert.equal(await main(['init', '--from', 'shopify', '--name', 'X'], { out: () => {}, err: (s) => missing.push(s) }), 1);
    assert.match(missing.join('\n'), /Products > Export/);
  });
});

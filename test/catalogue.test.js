import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseRows, detectDelimiter } from '../src/lib/csv.js';
import { itemsFromRecords, parsePrice, parseStock, readSource } from '../src/lib/catalogue.js';
import { DEMO_CSV } from './helpers.js';

test('CSV: quotes, doubled quotes, line breaks in quotes, CRLF and BOM', () => {
  const text = '﻿name,notes\r\n"Eggs, large","Say ""hello""\nthen go"\r\nBread,plain\r\n';
  assert.deepEqual(parseRows(text), [['name', 'notes'], ['Eggs, large', 'Say "hello"\nthen go'], ['Bread', 'plain']]);
});

test('CSV: semicolon and tab exports are detected', () => {
  assert.equal(detectDelimiter('name;price\nEggs;3,20'), ';');
  assert.equal(detectDelimiter('name\tprice\nEggs\t3.20'), '\t');
  assert.equal(parseCsv('Name;Price (£)\nEggs;3.20').records[0].price, '3.20');
});

test('CSV: headers are normalised and blank rows keep row numbers right', () => {
  const { headers, records } = parseCsv('Product Name,Price (£),Available From\nEggs,3.20,Fri\n\nBread,4.50,\n');
  assert.deepEqual(headers, ['product_name', 'price', 'available_from']);
  assert.deepEqual(records.map((r) => r._row), [2, 4]);
});

test('prices and stock are parsed strictly', () => {
  assert.equal(parsePrice('£1,250.00'), 1250);
  assert.equal(parsePrice(' 3.2 '), 3.2);
  assert.equal(parsePrice(''), null);
  assert.ok(Number.isNaN(parsePrice('three pounds')));
  assert.ok(Number.isNaN(parsePrice('3.999')));
  assert.deepEqual(parseStock('12'), { stock: 12, inStock: true });
  assert.deepEqual(parseStock('sold out'), { stock: 0, inStock: false });
  assert.deepEqual(parseStock('yes'), { stock: null, inStock: true });
  assert.deepEqual(parseStock(''), { stock: null, inStock: null });
  assert.equal(parseStock('lots').stock, undefined);
});

test('rows without a usable name or price are skipped and reported, never guessed', () => {
  const { records } = parseCsv('name,price,stock\nEggs,3.20,4\n,1.00,\nBread,,\nJam,cheap,\nHoney,5,lots\n');
  const { items, problems } = itemsFromRecords(records);
  assert.deepEqual(items.map((i) => i.name), ['Eggs', 'Honey']);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /row 3: no name/);
  assert.match(problems.join('\n'), /row 4 \(Bread\): no price/);
  assert.match(problems.join('\n'), /row 5 \(Jam\): price "cheap"/);
  assert.match(problems.join('\n'), /row 6 \(Honey\): stock "lots"/);
});

test('missing SKUs are generated and duplicates renamed', () => {
  const { records } = parseCsv('sku,name,price\n,Free-range eggs,3\nA1,Bread,4\nA1,Cake,5\n');
  const { items, problems } = itemsFromRecords(records);
  assert.deepEqual(items.map((i) => i.sku), ['FREE-RANGE-EGGS', 'A1', 'A1-2']);
  assert.match(problems[0], /used twice/);
});

test('services can have a "from" price', () => {
  const { records } = parseCsv('name,price_from_gbp,kind,unit\nBoiler service,85,service,visit\n');
  const [item] = itemsFromRecords(records).items;
  assert.equal(item.kind, 'service');
  assert.equal(item.price, null);
  assert.equal(item.priceFrom, 85);
  assert.equal(item.currency, 'GBP');
});

test('the demo farm shop imports cleanly', async () => {
  const { items, problems } = await readSource({ type: 'csv', file: DEMO_CSV });
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => [i.sku, i.price, i.stock]), [['EGG-12', 3.2, 40], ['BRD-SD', 4.5, 12], ['VEG-BOX', 18, 15]]);
});

test('a URL that returns a web page instead of CSV gets a helpful error', async () => {
  const fetchImpl = async () => new Response('<!doctype html><html></html>', { status: 200 });
  await assert.rejects(readSource({ type: 'csv', file: 'https://docs.google.com/spreadsheets/d/x/edit' }, { fetchImpl }), /Publish to web/);
});

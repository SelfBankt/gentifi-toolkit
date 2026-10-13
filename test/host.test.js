import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHost } from '../src/lib/host.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { saveProject } from '../src/lib/project.js';
import { demoProject, withTempDir } from './helpers.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('one host serves many businesses, each under /b/<slug>/', async () => {
  await withTempDir(async (dir) => {
    for (const [slug, name] of [['hollow-lane', 'Hollow Lane Farm Shop'], ['corner-bakery', 'Corner Bakery']]) {
      await mkdir(join(dir, slug));
      const project = demoProject();
      project.business.name = name;
      await saveProject(join(dir, slug, 'gentifi.json'), project);
    }
    await mkdir(join(dir, 'Not A Slug'));
    await writeFile(join(dir, 'Not A Slug', 'gentifi.json'), '{}');
    await mkdir(join(dir, 'broken'));
    await writeFile(join(dir, 'broken', 'gentifi.json'), '{ not json');

    const logs = [];
    let host;
    const { server, url } = await listen((req, res) => host.handle(req, res));
    try {
      host = createHost({ dir, baseUrl: url, log: (m) => logs.push(m) });
      await host.scan();
      assert.deepEqual([...host.businesses.keys()].sort(), ['corner-bakery', 'hollow-lane']);
      assert.ok(logs.some((l) => l.startsWith('Skipped broken')), 'a broken business is skipped, not fatal');

      const page = await fetch(`${url}/b/corner-bakery/`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Corner Bakery/);
      assert.match(html, new RegExp(`data-copy="${url}/mcp"`), 'hosted scan pages give the one network connector');
      assert.match(html, /Does Corner Bakery have /);
      const ard = await (await fetch(`${url}/b/hollow-lane/.well-known/ard.json`)).json();
      assert.match(JSON.stringify(ard), new RegExp(`${url}/b/hollow-lane/mcp`));
      assert.equal((await fetch(`${url}/b/hollow-lane`, { redirect: 'manual' })).headers.get('location'), '/b/hollow-lane/');
      assert.equal((await fetch(`${url}/b/nobody/`)).status, 404);
      assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, businesses: 2 });
      const card = await (await fetch(`${url}/.well-known/mcp/server-card.json`)).json();
      assert.equal(card.title, 'Gentifi');
      assert.equal(card.remotes[0].url, `${url}/mcp`, 'the .well-known card describes the network connector');
      const cards = await (await fetch(`${url}/.well-known/mcp/server-cards.json`)).json();
      assert.deepEqual(cards.servers.map((c) => c.remotes[0].url).sort(), [`${url}/b/corner-bakery/mcp`, `${url}/b/hollow-lane/mcp`, `${url}/mcp`]);
      assert.equal((await fetch(`${url}/.well-known/openai-apps-challenge`)).status, 404);
      await writeFile(join(dir, '.openai-apps-challenge'), 'token-123\n');
      assert.equal(await (await fetch(`${url}/.well-known/openai-apps-challenge`)).text(), 'token-123', 'the domain check gets the bare token');

      const client = new McpHttpClient(`${url}/b/corner-bakery/mcp`);
      await client.connect();
      const tools = await client.request('tools/list', {});
      assert.ok(tools.tools.some((t) => t.name === 'prepare_order'));
      const info = await client.request('tools/call', { name: 'get_business_info', arguments: {} });
      assert.match(JSON.stringify(info), /Corner Bakery/, 'tool calls reach the right business');
    } finally {
      server.close();
    }
  });
});

test('the host re-reads each business sheet, keeps the last good catalogue, and picks up new folders', async () => {
  await withTempDir(async (dir) => {
    let csv = 'Item,Price,Stock\nFree-range eggs (dozen),3.20,40\nSourdough loaf,4.50,12\n';
    const sheet = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(csv);
    });
    try {
      await mkdir(join(dir, 'corner-bakery'));
      const project = demoProject();
      project.catalogue.source = { type: 'csv', file: `${sheet.url}/sheet.csv` };
      const path = join(dir, 'corner-bakery', 'gentifi.json');
      await saveProject(path, project);
      const logs = [];
      const host = createHost({ dir, baseUrl: 'https://mcp.example', log: (m) => logs.push(m) });
      await host.scan();

      csv = 'Item,Price,Stock\nFree-range eggs (dozen),3.40,0\nSourdough loaf,4.50,12\n';
      await host.syncAll();
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const eggs = saved.catalogue.items.find((i) => /eggs/i.test(i.name));
      assert.equal(eggs.price, 3.4);
      assert.equal(eggs.stock, 0);
      assert.ok(logs.some((l) => l.includes('[corner-bakery] Synced')));

      csv = 'Nothing,useful\n';
      await host.syncAll();
      assert.equal(JSON.parse(await readFile(path, 'utf8')).catalogue.items.length, 2, 'a broken sheet never empties the catalogue');

      await mkdir(join(dir, 'new-shop'));
      await saveProject(join(dir, 'new-shop', 'gentifi.json'), demoProject());
      await host.scan();
      assert.ok(host.businesses.has('new-shop'));
    } finally {
      sheet.server.close();
    }
  });
});

test('the network connector at /mcp reaches every business by id or name', async () => {
  await withTempDir(async (dir) => {
    for (const [slug, name, item] of [['hollow-lane', 'Hollow Lane Farm Shop', 'Free-range eggs (dozen)'], ['corner-bakery', 'Corner Bakery', 'Sourdough loaf']]) {
      await mkdir(join(dir, slug));
      const project = demoProject();
      project.business.name = name;
      project.catalogue.items = [{ ...project.catalogue.items[0], sku: 'ITEM-1', name: item, category: '', description: '', price: 3.2, stock: 10 }];
      await saveProject(join(dir, slug, 'gentifi.json'), project);
    }
    let host;
    const { server, url } = await listen((req, res) => host.handle(req, res));
    try {
      host = createHost({ dir, baseUrl: url });
      await host.scan();
      const client = new McpHttpClient(`${url}/mcp`);
      await client.connect();
      const { tools } = await client.request('tools/list', {});
      assert.deepEqual(tools.map((t) => t.name), ['find_businesses', 'get_business_info', 'search_catalogue', 'check_availability', 'prepare_order']);
      assert.ok(tools.find((t) => t.name === 'prepare_order').inputSchema.required.includes('business'));

      const call = async (name, args) => (await client.request('tools/call', { name, arguments: args }));
      const found = (await call('find_businesses', { query: 'eggs' })).structuredContent;
      assert.deepEqual(found.businesses.map((b) => b.id), ['hollow-lane']);
      assert.deepEqual(found.businesses[0].matchingItems, ['Free-range eggs (dozen)']);
      assert.equal((await call('find_businesses', {})).structuredContent.total, 2);

      const search = (await call('search_catalogue', { business: 'Hollow Lane Farm', query: 'eggs' })).structuredContent;
      assert.equal(search.business, 'Hollow Lane Farm Shop');
      assert.equal(search.items[0].name, 'Free-range eggs (dozen)');
      const order = (await call('prepare_order', { business: 'corner-bakery', items: [{ sku: 'ITEM-1', quantity: 2 }] })).structuredContent;
      assert.equal(order.status, 'not_ordered');
      assert.equal(order.business, 'Corner Bakery');

      const missing = await call('get_business_info', { business: 'Nowhere Deli' });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /No business on Gentifi matches/);
    } finally {
      server.close();
    }
  });
});

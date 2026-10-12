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
      assert.match(await page.text(), /Corner Bakery/);
      const ard = await (await fetch(`${url}/b/hollow-lane/.well-known/ard.json`)).json();
      assert.match(JSON.stringify(ard), new RegExp(`${url}/b/hollow-lane/mcp`));
      assert.equal((await fetch(`${url}/b/hollow-lane`, { redirect: 'manual' })).headers.get('location'), '/b/hollow-lane/');
      assert.equal((await fetch(`${url}/b/nobody/`)).status, 404);
      assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, businesses: 2 });

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

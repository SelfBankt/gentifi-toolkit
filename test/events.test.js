import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHost } from '../src/lib/host.js';
import { eventCollection } from '../src/lib/events.js';
import { validateCollection } from '../src/lib/collections.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { saveProject } from '../src/lib/project.js';
import { demoProject, withTempDir } from './helpers.js';

async function hostWith(dir, fn) {
  for (const [slug, name, item] of [['hollow-lane', 'Hollow Lane Farm Shop', 'Free-range eggs (dozen)'], ['corner-bakery', 'Corner Bakery', 'Sourdough loaf'], ['far-away', 'Far Away Deli', 'Olives']]) {
    await mkdir(join(dir, slug));
    const p = demoProject();
    p.business.name = name;
    p.catalogue.items = [{ ...p.catalogue.items[0], sku: 'ITEM-1', name: item, category: '', description: '', price: 3.2, stock: 10 }];
    await saveProject(join(dir, slug, 'gentifi.json'), p);
  }
  await mkdir(join(dir, '_collections'));
  await writeFile(join(dir, '_collections', 'sodbury-market.json'), JSON.stringify({ name: 'Sodbury Market', kind: 'event', validFrom: '2026-11-07', validTo: '2026-11-07', members: ['hollow-lane', 'corner-bakery', 'not-hosted-yet'] }));
  await writeFile(join(dir, '_collections', 'broken.json'), '{ "name": "Broken"');
  const logs = [];
  let host;
  const server = createServer((req, res) => host.handle(req, res));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    host = createHost({ dir, baseUrl: url, log: (m) => logs.push(m) });
    await host.scan();
    await fn({ url, host, logs });
  } finally {
    server.close();
  }
}

test('an event gets a page, signs and its own connector limited to its traders', async () => {
  await withTempDir((dir) => hostWith(dir, async ({ url, host, logs }) => {
    assert.deepEqual([...host.events.keys()], ['sodbury-market']);
    assert.ok(logs.some((l) => l.startsWith('Skipped event broken')), 'a broken event file is skipped, not fatal');
    assert.ok(logs.some((l) => l.includes('not hosted yet: not-hosted-yet')));

    const page = await (await fetch(`${url}/c/sodbury-market/`)).text();
    assert.match(page, /Add Sodbury Market to your AI assistant/);
    assert.match(page, /2 traders at Sodbury Market/);
    assert.match(page, new RegExp(`data-copy="${url}/c/sodbury-market/mcp"`));
    assert.doesNotMatch(page, /Far Away Deli/);
    assert.match(await (await fetch(`${url}/c/sodbury-market/badge.svg`)).text(), /Sodbury Market/);
    assert.equal((await fetch(`${url}/c/nowhere/`)).status, 404);

    const client = new McpHttpClient(`${url}/c/sodbury-market/mcp`);
    const init = await client.connect();
    assert.equal(init.serverInfo?.title ?? init.result?.serverInfo?.title ?? 'Sodbury Market', 'Sodbury Market');
    const call = (name, args) => client.request('tools/call', { name, arguments: args });
    const all = (await call('find_businesses', {})).structuredContent;
    assert.deepEqual(all.businesses.map((b) => b.id).sort(), ['corner-bakery', 'hollow-lane'], 'only the event\'s traders');
    assert.equal((await call('search_catalogue', { business: 'Far Away Deli', query: 'olives' })).isError, true, 'other shops are out of reach');
    assert.equal((await call('search_catalogue', { business: 'Corner Bakery', query: 'sourdough' })).structuredContent.items[0].name, 'Sourdough loaf');

    const cards = await (await fetch(`${url}/.well-known/mcp/server-cards.json`)).json();
    assert.ok(cards.servers.some((c) => c.remotes[0].url === `${url}/c/sodbury-market/mcp`));
  }));
});

test('an event publishes a valid Business Collections draft 0.2 document', async () => {
  await withTempDir((dir) => hostWith(dir, async ({ host }) => {
    const event = host.events.get('sodbury-market');
    const doc = eventCollection(event, [...event.memberShops.values()], 'https://mcp.gentifi.com');
    assert.equal(doc.entries.length, 2);
    assert.equal(doc.collection.connector, 'https://mcp.gentifi.com/c/sodbury-market/mcp');
    const fails = validateCollection(doc, { servedFrom: 'https://mcp.gentifi.com/c/sodbury-market/collection.json' }).filter((r) => r.level === 'fail');
    assert.deepEqual(fails, []);
  }));
});

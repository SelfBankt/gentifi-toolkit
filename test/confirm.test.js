import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHost } from '../src/lib/host.js';
import { createStats } from '../src/lib/stats.js';
import { orderRef, orderToken, readOrderToken } from '../src/lib/confirm.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { loadProject, saveProject } from '../src/lib/project.js';
import { demoProject, withTempDir } from './helpers.js';

const order = { business: 'hollow-lane', items: [['EGG-12', 2]], collectionDate: 'Saturday', note: '', pricesAsOf: '2026-10-11T09:00:00.000Z', preparedAt: '2026-10-15T10:00:00.000Z' };

test('order links carry the order, signed: altered or week-old links are refused', () => {
  const token = orderToken('secret', order);
  const now = new Date('2026-10-16T10:00:00Z');
  assert.deepEqual(readOrderToken('secret', token, now), { ...order, items: [{ sku: 'EGG-12', quantity: 2 }] });
  assert.equal(readOrderToken('other secret', token, now), null, 'signed with another key');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(Buffer.from(body, 'base64url').toString().replace('"EGG-12",2', '"EGG-12",200')).toString('base64url');
  assert.equal(readOrderToken('secret', `${forged}.${mac}`, now), null, 'quantities cannot be changed');
  assert.equal(readOrderToken('secret', token, new Date('2026-10-23T10:00:01Z')), null, 'links last a week');
  assert.equal(readOrderToken('secret', 'nonsense', now), null);
  assert.match(orderRef(token), /^[0-9A-F]{8}$/);
});

test('prepare_order links to a confirmation page; only Confirm records a witness, once, without the note', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const stats = createStats({ dir });
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, stats, env: { GENTIFI_ORDER_SECRET: 'test-secret' } });
      await host.scan();
      const client = new McpHttpClient(`${url}/mcp`);
      await client.connect();
      const result = await client.request('tools/call', { name: 'prepare_order', arguments: { business: 'hollow-lane', items: [{ sku: 'EGG-12', quantity: 2 }, { sku: 'BRD-SD', quantity: 1 }], collection_date: 'Saturday', note: 'Call me on 07700 900123' } });
      const prepared = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(prepared.status, 'not_ordered');
      assert.equal(prepared.nextStep.type, 'confirm');
      assert.match(prepared.nextStep.url, new RegExp(`^${url}/o/[\\w-]+\\.[\\w-]+$`));
      assert.match(prepared.nextStep.instructions, /send the reservation request/);
      const link = prepared.nextStep.url;
      const witnessFile = join(dir, 'hollow-lane', 'witness.jsonl');

      // Opening the link (or a chat app's preview of it) only shows the order
      const page = await fetch(link, { headers: { 'user-agent': 'Slackbot-LinkExpanding' } });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const html = await page.text();
      assert.match(html, /Your order with Hollow Lane Farm Shop/);
      assert.match(html, /Free-range eggs \(dozen\)<\/td><td class="num">2<\/td><td class="num">£6\.40/);
      assert.match(html, /Total<\/td><td class="num">£10\.90/);
      assert.match(html, /<form method="post"><button class="btn" type="submit">Confirm<\/button>/);
      assert.doesNotMatch(html, /updated its catalogue/);
      await assert.rejects(readFile(witnessFile), 'nothing recorded before Confirm');

      // Confirm, then the page shows the reference and the business's own next step
      const confirmed = await fetch(link, { method: 'POST', redirect: 'manual' });
      assert.equal(confirmed.status, 303);
      const after = await (await fetch(link)).text();
      const ref = orderRef(link.split('/o/')[1]);
      assert.match(after, new RegExp(`Reference <span class="ref">${ref}</span>`));
      assert.match(after, /href="mailto:orders%40hollowlane\.example\?subject=Reservation%20request/);
      assert.match(after, new RegExp(`Gentifi%20reference%3A%20${ref}`));
      assert.match(after, /One more step: send the reservation request/);

      await fetch(link, { method: 'POST', redirect: 'manual' });
      const lines = (await readFile(witnessFile, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1, 'confirming twice records once');
      const witness = JSON.parse(lines[0]);
      assert.equal(witness.ref, ref);
      assert.equal(witness.total, 10.9);
      assert.deepEqual(witness.lines.map((l) => [l.sku, l.quantity, l.lineTotal]), [['EGG-12', 2, 6.4], ['BRD-SD', 1, 4.5]]);
      assert.equal(witness.collectionDate, 'Saturday');
      assert.doesNotMatch(lines[0], /07700/, 'the note is kept only as a hash');
      assert.match(witness.noteSha256, /^[0-9a-f]{64}$/);

      await stats.flush();
      const saved = JSON.parse(await readFile(join(dir, 'hollow-lane', 'stats.json'), 'utf8'));
      assert.equal(Object.values(saved.days)[0].confirmations, 1);

      // A changed catalogue shows today's prices with a notice; an altered link is refused
      const project = await loadProject(join(dir, 'hollow-lane', 'gentifi.json'));
      project.catalogue.items[0].price = 3.5;
      project.catalogue.updatedAt = '2026-10-15T12:00:00.000Z';
      await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), project);
      await host.scan();
      const again = await client.request('tools/call', { name: 'prepare_order', arguments: { business: 'hollow-lane', items: [{ sku: 'EGG-12', quantity: 1 }] } });
      const fresh = (again.structuredContent ?? JSON.parse(again.content[0].text)).nextStep.url;
      assert.doesNotMatch(await (await fetch(fresh)).text(), /updated its catalogue/);
      const stale = await (await fetch(`${url}/o/${orderToken('test-secret', { ...order, items: [['EGG-12', 1]], preparedAt: new Date().toISOString() })}`)).text();
      assert.match(stale, /Hollow Lane Farm Shop has updated its catalogue/);
      assert.match(stale, /£3\.50/);
      assert.equal((await fetch(`${link.slice(0, -2)}xx`)).status, 404);
      assert.equal((await fetch(`${url}/o/${orderToken('test-secret', { ...order, items: [['NOPE', 1]], preparedAt: new Date().toISOString() })}`)).status, 409);
    } finally {
      server.close();
    }
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
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

/** A stand-in for the owner bot (gentifi-profile's relay/handoff.py). */
async function fakeBot(dir) {
  const secretFile = join(dir, 'handoff-secret');
  await writeFile(secretFile, 'bot-secret\n');
  const bot = { telegram: true, orders: [], state: null, calls: 0 };
  const server = createServer(async (req, res) => {
    bot.calls++;
    const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== 'Bearer bot-secret') return reply(401, { error: 'not authorised' });
    if (req.method === 'GET' && req.url === '/handoff/businesses/gtf_hollowlanefarmshop') return reply(200, { telegram: bot.telegram });
    if (req.method === 'POST' && req.url === '/handoff/orders') {
      let body = '';
      for await (const chunk of req) body += chunk;
      bot.orders.push(JSON.parse(body));
      if (bot.refuse) return reply(bot.refuse.status, bot.refuse.body);
      bot.state = { status: 'pending_confirmation', reference: 'GTF-1A2B3C4D', confirm_by: '2026-10-15T13:00:00+00:00' };
      return reply(200, bot.state);
    }
    if (req.method === 'GET' && req.url.startsWith('/handoff/orders/gtf_hollowlanefarmshop/')) return bot.state ? reply(200, bot.state) : reply(404, {});
    return reply(404, {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  bot.env = { GENTIFI_BOT_URL: `http://127.0.0.1:${server.address().port}`, GENTIFI_BOT_SECRET_FILE: secretFile };
  bot.close = () => server.close();
  return bot;
}

test('owners on Telegram get the order there, and the page shows their answer', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const bot = await fakeBot(dir);
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, env: { GENTIFI_ORDER_SECRET: 'test-secret', ...bot.env } });
      await host.scan();
      const profile = JSON.parse(await readFile(join(dir, 'hollow-lane', 'gentifi-profile.json'), 'utf8'));
      assert.equal(profile.business.id, 'gtf_hollowlanefarmshop', 'the bot reads the business from its folder');

      const token = orderToken('test-secret', { ...order, items: [['EGG-12', 2]], note: 'Brown eggs please', preparedAt: new Date().toISOString() });
      const link = `${url}/o/${token}`;
      const ref = orderRef(token);
      const page = await (await fetch(link)).text();
      assert.match(page, /<label for="name">Your name<\/label>/);
      assert.match(page, /These go only to Hollow Lane Farm Shop/);
      assert.match(page, /this page shows their answer/);

      const form = (fields) => fetch(link, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
      const missing = await form({ name: 'Sam Carter', contact: ' ' });
      assert.equal(missing.status, 400);
      assert.match(await missing.text(), /Add your name and a phone number or email/);
      assert.equal(bot.orders.length, 0);

      assert.equal((await form({ name: 'Sam Carter', contact: '07700 900123' })).status, 303);
      assert.equal(bot.orders.length, 1);
      const sent = bot.orders[0];
      assert.equal(sent.business_id, 'gtf_hollowlanefarmshop');
      assert.equal(sent.ref, ref);
      assert.deepEqual(sent.items, [{ offering_id: 'egg-12', quantity: 2 }]);
      assert.deepEqual(sent.customer, { name: 'Sam Carter', contact: '07700 900123' });
      assert.equal(sent.collection_date, 'Saturday');
      assert.equal(sent.note, 'Brown eggs please');

      const witness = JSON.parse((await readFile(join(dir, 'hollow-lane', 'witness.jsonl'), 'utf8')).trim());
      assert.equal(witness.handedTo, 'telegram');
      assert.doesNotMatch(JSON.stringify(witness), /Sam|07700/, 'Gentifi keeps no customer details');

      const waiting = await (await fetch(link)).text();
      assert.match(waiting, /Waiting for Hollow Lane Farm Shop to accept/);
      assert.match(waiting, /They have until 14:00 to answer/);
      assert.match(waiting, /<meta http-equiv="refresh" content="20">/);

      bot.state = { status: 'confirmed', payment: { status: 'awaiting', checkout_url: 'lightning:lnbc10u1pfake' }, message: 'Confirmed. Pay using checkout_url.' };
      const accepted = await (await fetch(link)).text();
      assert.match(accepted, /Hollow Lane Farm Shop accepted your order/);
      assert.match(accepted, /href="lightning:lnbc10u1pfake">Pay Hollow Lane Farm Shop/);
      assert.doesNotMatch(accepted, /checkout_url/, 'agent wording stays out of the page');

      bot.state = { status: 'declined', message: 'Hollow Lane Farm Shop can’t do the time asked but suggests Sunday instead. If that suits the customer, send a new request for that time.' };
      const declined = await (await fetch(link)).text();
      assert.match(declined, /can’t take this order/);
      assert.match(declined, /suggests Sunday instead\./);
      assert.doesNotMatch(declined, /send a new request/);
      assert.match(declined, /href="mailto:orders%40hollowlane\.example/, 'the usual way to reach them');

      bot.state = null;
      assert.match(await (await fetch(link)).text(), /We can’t show Hollow Lane Farm Shop’s answer right now/);
    } finally {
      server.close();
      bot.close();
    }
  });
});

test('without Telegram, or when the bot is down, orders go by email as before', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const bot = await fakeBot(dir);
    bot.telegram = false;
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, env: { GENTIFI_ORDER_SECRET: 'test-secret', ...bot.env } });
      await host.scan();
      const token = orderToken('test-secret', { ...order, preparedAt: new Date().toISOString() });
      const link = `${url}/o/${token}`;
      assert.doesNotMatch(await (await fetch(link)).text(), /Your name/);
      await fetch(link, { method: 'POST', redirect: 'manual' });
      assert.equal(bot.orders.length, 0);
      assert.match(await (await fetch(link)).text(), /One more step: send the reservation request/);

      // The bot refuses the order (an error, or an old bot answering "failed"): hand over as before
      bot.telegram = true;
      for (const [i, refuse] of [{ status: 422, body: { error: 'refused' } }, { status: 200, body: { status: 'failed', message: 'refused' } }].entries()) {
        bot.refuse = refuse;
        const refused = `${url}/o/${orderToken('test-secret', { ...order, items: [['VEG-BOX', i + 1]], preparedAt: new Date().toISOString() })}`;
        await fetch(refused, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Sam&contact=07700%20900123' });
        assert.match(await (await fetch(refused)).text(), /One more step: send the reservation request/, `refused with ${refuse.status}`);
      }

      bot.close();
      const other = `${url}/o/${orderToken('test-secret', { ...order, items: [['BRD-SD', 1]], preparedAt: new Date().toISOString() })}`;
      bot.telegram = true;
      assert.doesNotMatch(await (await fetch(other)).text(), /Your name/, 'an unreachable bot never blocks an order');
      await fetch(other, { method: 'POST', redirect: 'manual' });
      assert.match(await (await fetch(other)).text(), /One more step: send the reservation request/);
    } finally {
      server.close();
    }
  });
});

test('a business the bot is still onboarding stays hidden until its owner goes live', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const list = join(dir, 'onboarding.json');
    let tick = 0;
    const setList = async (ids) => {
      await writeFile(list, JSON.stringify({ onboarding: ids }));
      const t = new Date(Date.now() + 1000 * ++tick);
      await utimes(list, t, t); // a new modification time, as each rewrite has
    };
    await setList(['gtf_hollowlanefarmshop']);
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, botCheckMs: 0,
        env: { GENTIFI_ORDER_SECRET: 'test-secret', GENTIFI_ONBOARDING_FILE: list, GENTIFI_BOT_URL: 'http://127.0.0.1:9', GENTIFI_BOT_SECRET_FILE: join(dir, 'none') } });
      await host.scan();
      assert.equal(host.mounted.size, 1);
      assert.equal(JSON.parse(await readFile(join(dir, 'hollow-lane', 'gentifi-profile.json'), 'utf8')).business.id, 'gtf_hollowlanefarmshop',
        'the bot still gets it, to show the owner');

      const client = new McpHttpClient(`${url}/mcp`);
      await client.connect();
      const found = async () => {
        const r = await client.request('tools/call', { name: 'find_businesses', arguments: { query: '' } });
        return JSON.stringify(r.structuredContent ?? r.content);
      };
      const link = `${url}/o/${orderToken('test-secret', { ...order, preparedAt: new Date().toISOString() })}`;
      assert.doesNotMatch(await found(), /Hollow Lane/, 'agents can’t find it');
      assert.equal((await fetch(`${url}/b/hollow-lane/`)).status, 404, 'no page yet');
      assert.equal((await fetch(link)).status, 404, 'no orders yet');
      assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, businesses: 0 });

      await writeFile(list, '{"onboarding": [');
      await utimes(list, new Date(Date.now() + 1e6), new Date(Date.now() + 1e6));
      assert.doesNotMatch(await found(), /Hollow Lane/, 'a broken list keeps the last one');

      await setList([]); // the owner tapped Go live
      assert.match(await found(), /Hollow Lane/);
      assert.equal((await fetch(`${url}/b/hollow-lane/`)).status, 200);
      assert.equal((await fetch(link)).status, 200);
    } finally {
      server.close();
    }
  });
});

test('what the owner marks sold out in Telegram is what agents see, until the sheet is read again', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'hollow-lane'));
    await saveProject(join(dir, 'hollow-lane', 'gentifi.json'), demoProject());
    const file = join(dir, 'stock.json');
    let tick = 0;
    const setMarks = async (marks) => {
      await writeFile(file, JSON.stringify({ stock: { gtf_hollowlanefarmshop: marks } }));
      const t = new Date(Date.now() + 1000 * ++tick);
      await utimes(file, t, t);
    };
    const later = new Date(Date.now() + 60_000).toISOString();
    await setMarks({ 'egg-12': { status: 'out_of_stock', at: later } });
    let host;
    const server = createServer((req, res) => host.handle(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      host = createHost({ dir, baseUrl: url, botCheckMs: 0,
        env: { GENTIFI_ORDER_SECRET: 'test-secret', GENTIFI_STOCK_FILE: file, GENTIFI_BOT_URL: 'http://127.0.0.1:9', GENTIFI_BOT_SECRET_FILE: join(dir, 'none') } });
      await host.scan();
      const client = new McpHttpClient(`${url}/mcp`);
      await client.connect();
      const check = async () => (await client.request('tools/call', {
        name: 'check_availability', arguments: { business: 'hollow-lane', sku: 'EGG-12' } })).structuredContent;
      const available = async () => (await check()).available;
      const sold = await check();
      assert.equal(sold.available, false, 'sold out, as the owner said');
      assert.equal(sold.availability, 'Sold out', 'the availability text agrees, not the sheet’s "In stock"');
      assert.equal(sold.stockSource, 'owner');
      assert.equal(sold.stockAsOf, later);
      assert.match(sold.note, /marked this sold out at .*after the catalogue was last updated/);
      const saved = await loadProject(join(dir, 'hollow-lane', 'gentifi.json'));
      assert.equal(saved.catalogue.items.find((i) => i.sku === 'EGG-12').stock, 40, 'the saved project keeps the sheet');
      const profile = JSON.parse(await readFile(join(dir, 'hollow-lane', 'gentifi-profile.json'), 'utf8'));
      assert.equal(profile.availability.find((r) => r.offering_id === 'egg-12').status, 'in_stock', 'so does the bot’s profile');

      await setMarks({ 'egg-12': { status: 'in_stock', at: later } });
      const back = await check();
      assert.equal(back.available, true, 'back in stock');
      assert.equal(back.availability, 'In stock', 'the sheet’s own note stays');
      assert.match(back.note, /marked this back in stock at .*how many isn’t known/);

      await setMarks({ 'egg-12': { status: 'out_of_stock', at: '2020-01-01T00:00:00Z' } });
      assert.equal(await available(), true, 'a mark older than the sheet gives way to it');
      assert.equal((await check()).stockSource, undefined, 'and the item no longer says the owner marked it');

      await writeFile(file, '{"stock": ');
      await utimes(file, new Date(Date.now() + 1e6), new Date(Date.now() + 1e6));
      assert.equal(await available(), true, 'a broken file keeps the last marks');
    } finally {
      server.close();
    }
  });
});

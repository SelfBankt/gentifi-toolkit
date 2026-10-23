import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import draft from '../src/commands/draft.js';
import { draftFromReply, parseReply, readPhotos, tidyCapitals, toCsv } from '../src/lib/draft.js';
import { itemsFromRecords } from '../src/lib/catalogue.js';
import { parseCsv } from '../src/lib/csv.js';
import { capture, withTempDir } from './helpers.js';

// A fictional bakery's board, as a model might read it
const REPLY = {
  items: [
    { name: 'Sourdough loaf', price: 4.5, unit: 'each', category: 'Bread', unsure: '' },
    { name: 'Cinnamon bun', price: '£2.80', category: 'Pastries' },
    { name: 'Celebration cake', price: null, price_from: 25, unit: '', notice: 'order 48 hours ahead', dietary: 'can be gluten-free' },
    { name: 'Seeded rye', price: null, unsure: 'price smudged, could be 3.50 or 8.50' },
    { name: 'Sourdough loaf', price: 6, unsure: '' },
    { name: '', price: 1 },
  ],
  business: { name: 'Millbrook Bakery', opening_hours: ['Tu-Sa 08:00-15:00'], phone: '01632 960123', email: '', website: '', address: '' },
  unreadable: ['bottom right corner, glare'],
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fakeAi(reply, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = status === 200
      ? JSON.stringify({ choices: [{ message: { content: `Here you go:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] })
      : JSON.stringify({ error: { message: 'image input is not supported by this model' } });
    return new Response(text, { status });
  };
  return { calls, fetchImpl };
}

test('a reply becomes catalogue rows, with anything doubtful flagged and no price guessed', () => {
  const { rows, business, unreadable } = draftFromReply(REPLY);
  assert.deepEqual(rows.map((r) => [r.name, r.price, r.price_from]), [
    ['Sourdough loaf', 4.5, ''], ['Cinnamon bun', 2.8, ''], ['Celebration cake', '', 25], ['Seeded rye', '', ''], ['Sourdough loaf', 6, ''],
  ]);
  assert.equal(rows[0].check, '');
  assert.match(rows[3].check, /price smudged.*; no price read: add it, or this row is left out/);
  assert.match(rows[4].check, /same name as row 2/);
  assert.equal(rows[2].notice, 'order 48 hours ahead');
  assert.equal(business.name, 'Millbrook Bakery');
  assert.deepEqual(business.openingHours, ['Tu-Sa 08:00-15:00']);
  assert.deepEqual(unreadable, ['bottom right corner, glare']);
  assert.match(draftFromReply({ items: [{ name: 'Hamper', price: 'about ten' }] }).rows[0].check, /isn't a number/);
  assert.match(draftFromReply({ items: [{ name: 'Whole lamb', price: 650 }] }).rows[0].check, /unusually high/);
});

test('the CSV goes straight into gentifi init, and rows without a price are left out', () => {
  const { rows } = draftFromReply(REPLY);
  const csv = toCsv([...rows, { name: 'Cake, "Victoria"', price: 3 }]);
  const { items, problems } = itemsFromRecords(parseCsv(csv).records);
  assert.deepEqual(items.map((i) => [i.name, i.price, i.priceFrom]), [
    ['Sourdough loaf', 4.5, null], ['Cinnamon bun', 2.8, null], ['Celebration cake', null, 25],
    ['Sourdough loaf', 6, null], ['Cake, "Victoria"', 3, null],
  ]);
  assert.ok(problems.some((p) => /Seeded rye.*no price, skipped/.test(p)), 'never a guessed price');
});

test('replies wrapped in text or a code fence are read; nonsense is refused', () => {
  assert.deepEqual(parseReply('Sure! ```json\n{"items": []}\n```'), { items: [] });
  assert.throws(() => parseReply('I cannot read this image.'), /didn’t reply with a catalogue/);
  assert.throws(() => parseReply('{"items": [}'), /wasn’t valid JSON/);
});

test('photos go to the model as images, with the key only in the header', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const { calls, fetchImpl } = fakeAi(REPLY);
    const env = { GENTIFI_AI_KEY: 'sk-test-key', GENTIFI_AI_MODEL: 'kimi-k3' };
    const reply = await readPhotos([photo], { env, fetchImpl });
    assert.equal(reply.business.name, 'Millbrook Bakery');
    const [{ url, init, body }] = calls;
    assert.equal(url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer sk-test-key');
    assert.match(init.headers['user-agent'], /^gentifi-toolkit\//);
    assert.match(init.headers['x-opencode-session'], /^gentifi-draft-[0-9a-f]{12}$/);
    assert.equal(body.model, 'kimi-k3');
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /Never guess or work out a price/);
    const image = body.messages[1].content.find((p) => p.type === 'image_url');
    assert.equal(image.image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.doesNotMatch(init.body, /sk-test-key/, 'the key never goes in the request body');
  });
});

test('missing key or model, wrong photos and refusals give plain messages', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const { fetchImpl } = fakeAi(REPLY);
    const noKey = { GENTIFI_AI_MODEL: 'kimi-k3', GENTIFI_AI_KEY_FILE: join(dir, 'missing') };
    await assert.rejects(readPhotos([photo], { env: noKey, fetchImpl }), /No AI key: put it in/);
    await writeFile(join(dir, 'key'), 'sk-from-file\n');
    const fromFile = fakeAi(REPLY);
    await readPhotos([photo], { env: { ...noKey, GENTIFI_AI_KEY_FILE: join(dir, 'key') }, fetchImpl: fromFile.fetchImpl });
    assert.equal(fromFile.calls[0].init.headers.authorization, 'Bearer sk-from-file');

    const env = { GENTIFI_AI_KEY: 'k', GENTIFI_AI_MODEL: 'kimi-k3' };
    await assert.rejects(readPhotos([photo], { env: { GENTIFI_AI_KEY: 'k' }, fetchImpl }), /Choose a model that reads images/);
    await assert.rejects(readPhotos([join(dir, 'IMG_0001.HEIC')], { env, fetchImpl }), /sips -s format jpeg/);
    await assert.rejects(readPhotos([join(dir, 'board.pdf')], { env, fetchImpl }), /JPEG, PNG, WebP or GIF/);
    await assert.rejects(readPhotos(Array(6).fill(photo), { env, fetchImpl }), /At most 5 photos/);
    await assert.rejects(readPhotos([photo], { env, fetchImpl: fakeAi(REPLY, { status: 401 }).fetchImpl }), /refused the key/);
    await assert.rejects(readPhotos([photo], { env, fetchImpl: fakeAi(REPLY, { status: 400 }).fetchImpl }), /may not read images/);
  });
});

test('gentifi draft writes the CSV and the notes for a person to check', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const io = capture();
    const env = { GENTIFI_AI_KEY: 'sk-test-key', GENTIFI_AI_MODEL: 'kimi-k3' };
    const code = await draft.run({ photo: [photo], out: join(dir, 'millbrook') }, io, [], { env, fetchImpl: fakeAi(REPLY).fetchImpl });
    assert.equal(code, 0, io.stderr);
    assert.match(io.stdout, /Drafted 5 items, 2 to check/);
    assert.doesNotMatch(io.stdout + io.stderr, /sk-test-key/);
    const csv = await readFile(join(dir, 'millbrook', 'catalogue.csv'), 'utf8');
    assert.match(csv, /^name,price,price_from,unit,category,description,allergens,dietary,notice,check\n/);
    const notes = await readFile(join(dir, 'millbrook', 'notes.md'), 'utf8');
    assert.match(notes, /- Hours: Tu-Sa 08:00-15:00/);
    assert.match(notes, /- Seeded rye: price smudged/);
    assert.match(notes, /--name "Millbrook Bakery"/);
    assert.match(notes, /--hours "Tu-Sa 08:00-15:00"/);
    assert.match(notes, /the toolkit never fills in business details by itself/);

    const empty = capture();
    assert.equal(await draft.run({ photo: [photo], out: join(dir, 'none') }, empty, [], { env, fetchImpl: fakeAi({ items: [] }).fetchImpl }), 1);
    assert.match(empty.stderr, /No items could be read/);
  });
});

test('names copied from a board in capitals get ordinary capitals', () => {
  assert.equal(tidyCapitals('FLAT WHITE'), 'Flat white');
  assert.equal(tidyCapitals('ESPRESSO MACCHIATO'), 'Espresso macchiato');
  assert.equal(tidyCapitals('BLT SANDWICH'), 'BLT sandwich', 'short words with no vowels stay');
  assert.equal(tidyCapitals('GF BROWNIE'), 'GF brownie');
  assert.equal(tidyCapitals('1/2 DOZEN EGGS'), '1/2 dozen eggs');
  assert.equal(tidyCapitals('Flat White'), 'Flat White', 'mixed case is left as written');
  assert.equal(tidyCapitals('iPhone case'), 'iPhone case');
  assert.equal(tidyCapitals('42'), '42');
  const { rows } = draftFromReply({ items: [{ name: 'CAPPUCCINO', price: 3.5, category: 'HOT DRINKS' }] });
  assert.deepEqual([rows[0].name, rows[0].category], ['Cappuccino', 'Hot drinks']);
});

/** A service where each model answers its own way: 'ok', 'no-temperature' (refuses it), 'gone', 'down' or 'key'. */
function fakeService(behaviour) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, temperature: body.temperature });
    const how = behaviour[body.model] ?? 'gone';
    if (how === 'key') return new Response('{"error":"bad key"}', { status: 401 });
    if (how === 'down') throw new Error('socket hang up');
    if (how === 'gone') return new Response('{"error":{"message":"Model not found"}}', { status: 404 });
    if (how === 'no-temperature' && body.temperature !== undefined) {
      return new Response('{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLY) } }] }));
  };
  return { calls, fetchImpl };
}

test('a model that refuses temperature 0 is asked again without it', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const { calls, fetchImpl } = fakeService({ 'kimi-k3.1-pro': 'no-temperature' });
    const reply = await readPhotos([photo], { env: { GENTIFI_AI_KEY: 'k', GENTIFI_AI_MODEL: 'kimi-k3.1-pro' }, fetchImpl });
    assert.equal(reply.model, 'kimi-k3.1-pro');
    assert.deepEqual(calls, [{ model: 'kimi-k3.1-pro', temperature: 0 }, { model: 'kimi-k3.1-pro', temperature: undefined }]);
  });
});

test('several models are tried in turn; a refused key stops at once', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const env = { GENTIFI_AI_KEY: 'k', GENTIFI_AI_MODEL: 'kimi-k3, kimi-k3.1-pro' };
    const first = fakeService({ 'kimi-k3': 'ok', 'kimi-k3.1-pro': 'ok' });
    assert.equal((await readPhotos([photo], { env, fetchImpl: first.fetchImpl })).model, 'kimi-k3');
    assert.equal(first.calls.length, 1, 'the first that works');

    const withdrawn = fakeService({ 'kimi-k3': 'gone', 'kimi-k3.1-pro': 'no-temperature' });
    const reply = await readPhotos([photo], { env, fetchImpl: withdrawn.fetchImpl });
    assert.equal(reply.model, 'kimi-k3.1-pro');
    assert.equal(reply.business.name, 'Millbrook Bakery');
    assert.deepEqual(withdrawn.calls.map((c) => c.model), ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro']);

    const down = fakeService({ 'kimi-k3': 'down', 'kimi-k3.1-pro': 'ok' });
    assert.equal((await readPhotos([photo], { env, fetchImpl: down.fetchImpl })).model, 'kimi-k3.1-pro', 'after a network failure too');

    const key = fakeService({ 'kimi-k3': 'key', 'kimi-k3.1-pro': 'ok' });
    await assert.rejects(readPhotos([photo], { env, fetchImpl: key.fetchImpl }), /refused the key/);
    assert.equal(key.calls.length, 1, 'no point trying another model with the same key');

    const none = fakeService({});
    await assert.rejects(readPhotos([photo], { env, fetchImpl: none.fetchImpl }),
      /None of the models could read it\. kimi-k3: The AI service answered 404.* \| kimi-k3\.1-pro: The AI service answered 404/);
  });
});

test('gentifi draft says which model read the photo', async () => {
  await withTempDir(async (dir) => {
    const photo = join(dir, 'board.png');
    await writeFile(photo, PNG);
    const { fetchImpl } = fakeService({ 'kimi-k3': 'gone', 'kimi-k3.1-pro': 'ok' });
    const io = capture();
    const code = await draft.run({ photo: [photo], out: join(dir, 'out') }, io, [],
      { env: { GENTIFI_AI_KEY: 'k', GENTIFI_AI_MODEL: 'kimi-k3,kimi-k3.1-pro' }, fetchImpl });
    assert.equal(code, 0, io.stderr);
    assert.match(io.stdout, /^Read with kimi-k3\.1-pro\.$/m);
    assert.match(await readFile(join(dir, 'out', 'notes.md'), 'utf8'), /An AI model \(kimi-k3\.1-pro\) read these/);
  });
});

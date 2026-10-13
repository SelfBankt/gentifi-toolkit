import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main, commands } from '../src/cli.js';
import { DEMO_CSV, capture, demoProject, withTempDir } from './helpers.js';

const initArgs = (dir, extra = []) => ['init', '--from', 'csv', '--file', DEMO_CSV, '--name', 'Hollow Lane Farm Shop', '--kind', 'Farm shop', '--email', 'orders@hollowlane.example', '--project', join(dir, 'gentifi.json'), ...extra];

test('help lists every command', async () => {
  const io = capture();
  assert.equal(await main([], io), 0);
  for (const name of Object.keys(commands)) assert.match(io.stdout, new RegExp(`\\b${name}\\b`));
  assert.match(io.stdout, /^gentifi 0\.1\.0:/);
});

test('unknown command fails', async () => {
  const io = capture();
  assert.equal(await main(['frobnicate'], io), 1);
  assert.match(io.stderr, /Unknown command/);
});

test('command --help exits 0 and shows options', async () => {
  const io = capture();
  assert.equal(await main(['init', '--help'], io), 0);
  assert.match(io.stdout, /--from <value>/);
  assert.match(io.stdout, /--hours <value>  Opening hours/);
});

test('init rejects an unknown source and needs a file and a name', async () => {
  for (const [args, message] of [
    [['init', '--from', 'fax'], /Unknown source "fax"/],
    [['init', '--from', 'csv'], /Pass the catalogue with --file/],
    [['init', '--from', 'csv', '--file', DEMO_CSV], /never guesses business details/],
    [['init', '--from', 'csv', '--file', DEMO_CSV, '--name', 'X', '--order', 'telepathy'], /Unknown ordering method/],
  ]) {
    const io = capture();
    assert.equal(await main(args, io), 1, args.join(' '));
    assert.match(io.stderr, message);
  }
});

test('sources that are not built yet exit 2 with a plan', async () => {
  for (const from of ['shopify', 'woocommerce', 'booking']) {
    const io = capture();
    assert.equal(await main(['init', '--from', from], io), 2);
    assert.match(io.stderr, /not implemented yet/);
    assert.match(io.stderr, /--from csv/);
  }
});

test('init, build and check work end to end on the demo catalogue', async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, 'gentifi.json');
    let io = capture();
    assert.equal(await main(initArgs(dir, ['--hours', 'Tu-Sa 09:00-17:00', '--hours', 'Su 10:00-14:00']), io), 0, io.stderr);
    assert.match(io.stdout, /3 items/);
    const saved = JSON.parse(await readFile(project, 'utf8'));
    assert.equal(saved.business.slug, 'hollow-lane-farm-shop');
    assert.deepEqual(saved.business.openingHours, ['Tu-Sa 09:00-17:00', 'Su 10:00-14:00']);
    assert.equal(saved.ordering.method, 'reserve');
    assert.equal(saved.publish.baseUrl, 'http://localhost:8787');

    io = capture();
    assert.equal(await main(initArgs(dir), io), 1);
    assert.match(io.stderr, /already exists/);

    io = capture();
    assert.equal(await main(['build', '--project', project, '--out', join(dir, 'dist')], io), 0, io.stderr);
    assert.deepEqual((await readdir(join(dir, 'dist'))).sort(), ['.well-known', 'SKILL.md', 'ard.json', 'badge.svg', 'business.jsonld', 'counter-card.svg', 'index.html', 'mcp', 'signs.html', 'website-snippet.txt']);

    io = capture();
    assert.equal(await main(['check', '--project', project], io), 0, io.stdout);
    assert.match(io.stdout, /Gentified ✓/);

    io = capture();
    assert.equal(await main(['check', '--project', project, '--json'], io), 0);
    const report = JSON.parse(io.stdout);
    assert.equal(report.gentified, true);
    assert.ok(report.results.length > 10);
  });
});

test('check fails, with reasons, when a project is not ready', async () => {
  await withTempDir(async (dir) => {
    const project = demoProject();
    project.ordering.method = null;
    const file = join(dir, 'gentifi.json');
    await writeFile(file, JSON.stringify(project));
    const io = capture();
    assert.equal(await main(['check', '--project', file], io), 1);
    assert.match(io.stdout, /✗ Say how customers order/);
    assert.match(io.stdout, /Not Gentified yet: 1 problem to fix/);
  });
});

test('sync reports what changed in the source', async () => {
  await withTempDir(async (dir) => {
    const csv = join(dir, 'stock.csv');
    await writeFile(csv, 'sku,name,price_gbp,stock\nEGG-12,Eggs,3.20,40\nBRD-SD,Bread,4.50,12\n');
    const project = join(dir, 'gentifi.json');
    assert.equal(await main(['init', '--from', 'csv', '--file', csv, '--name', 'Shop', '--project', project], capture()), 0);
    await writeFile(csv, 'sku,name,price_gbp,stock\nEGG-12,Eggs,3.40,0\nJAM-1,Jam,2.80,6\n');
    const io = capture();
    assert.equal(await main(['sync', '--project', project], io), 0, io.stderr);
    assert.match(io.stdout, /~ Eggs: £3\.20 -> £3\.40/);
    assert.match(io.stdout, /~ Eggs: stock 40 -> 0/);
    assert.match(io.stdout, /\+ Jam \(£2\.80\)/);
    assert.match(io.stdout, /- Bread/);
  });
});

test('publish to the network is not built yet; self-hosting needs a real address', async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, 'gentifi.json');
    assert.equal(await main(initArgs(dir), capture()), 0);
    let io = capture();
    assert.equal(await main(['publish', '--project', project], io), 2);
    assert.match(io.stderr, /not implemented yet/);
    io = capture();
    assert.equal(await main(['publish', '--project', project, '--self-host', join(dir, 'site')], io), 1);
    assert.match(io.stderr, /Set where the files will live/);

    await writeFile(project, JSON.stringify(demoProject()));
    io = capture();
    assert.equal(await main(['publish', '--project', project, '--self-host', join(dir, 'site')], io), 0, io.stderr);
    assert.match(io.stdout, /Keep the .well-known folder/);
    assert.match(await readFile(join(dir, 'site', '.well-known', 'ard.json'), 'utf8'), /urn:air:hollowlane.example:mcp:hollow-lane-farm-shop/);
  });
});

test('collection check validates a file and explains how to verify it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'c.json');
    await writeFile(file, JSON.stringify({ collection: { id: 'urn:air:shows.example:collection:x', name: 'X', kind: 'place', publisher: { name: 'Shows', domain: 'shows.example' } }, entries: [{ identifier: 'urn:air:a.example:mcp:a', displayName: 'A', type: 'application/mcp-server-card+json', url: 'https://a.example/c.json' }] }));
    let io = capture();
    assert.equal(await main(['collection', 'check', file], io), 0, io.stdout);
    assert.match(io.stdout, /Valid against draft 0\.2/);
    io = capture();
    assert.equal(await main(['collection', 'check', file, '--verify'], io), 1);
    assert.match(io.stderr, /--published-at/);
    io = capture();
    assert.equal(await main(['collection', 'frobnicate'], io), 1);
  });
});

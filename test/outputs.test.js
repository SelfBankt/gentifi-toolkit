import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOutputs, representativeQueries, COLLECTIONS_NS, ARD_CONTEXT } from '../src/lib/outputs.js';
import { validateArdManifest, validateServerCard, validateSkill } from '../src/lib/validate.js';
import { demoProject } from './helpers.js';

const files = (project = demoProject()) => generateOutputs(project, '0.1.0');
const json = (project, path) => JSON.parse(files(project).get(path));

test('writes every agent format, and the A2A card only when there is an A2A endpoint', () => {
  assert.deepEqual([...files().keys()].sort(), [
    '.well-known/ai-catalog.json', '.well-known/ard.json', 'SKILL.md', 'ard.json', 'badge.svg', 'business.jsonld', 'counter-card.svg', 'index.html', 'mcp/server-card.json', 'signs.html', 'website-snippet.txt',
  ]);
  const withA2a = demoProject({ a2a: { url: 'https://hollowlane.example/a2a' } });
  const card = json(withA2a, '.well-known/agent-card.json');
  assert.deepEqual(card.supportedInterfaces, [{ url: 'https://hollowlane.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.ok(card.skills.every((s) => s.id && s.name && s.description && s.tags.length));
  assert.equal(json(withA2a, 'ard.json').entries.at(-1).type, 'application/a2a-agent-card+json');
});

test('the ARD manifest follows v0.91 and is the same at every path', () => {
  const out = files();
  assert.equal(out.get('ard.json'), out.get('.well-known/ard.json'));
  assert.equal(out.get('ard.json'), out.get('.well-known/ai-catalog.json'));
  const manifest = JSON.parse(out.get('ard.json'));
  assert.ok(validateArdManifest(manifest, { expectHost: 'hollowlane.example' }).every((r) => r.level === 'pass'));
  const [mcp] = manifest.entries;
  assert.equal(mcp.identifier, 'urn:air:hollowlane.example:mcp:hollow-lane-farm-shop');
  assert.equal(mcp.url, 'https://hollowlane.example/mcp/server-card.json');
  assert.deepEqual(mcp.capabilities, ['get_business_info', 'search_catalogue', 'check_availability', 'prepare_order']);
  assert.equal(mcp['@context'], undefined);
});

test('representative queries come from real catalogue items, 2 to 5 of them', () => {
  const q = representativeQueries(demoProject());
  assert.ok(q.length >= 2 && q.length <= 5);
  assert.equal(q[0], 'Does Hollow Lane Farm Shop have Free-range eggs (dozen) in stock?');
  const tiny = demoProject();
  tiny.catalogue.items = tiny.catalogue.items.slice(0, 1);
  tiny.business.openingHours = [];
  tiny.ordering.method = null;
  assert.equal(representativeQueries(tiny).length, 2);
});

test('collection membership is published as a col:memberOf back-link', () => {
  const project = demoProject({ memberOf: [{ collection: 'https://traders.example/collections/demo-high-street.json', role: { category: 'farm shop' } }] });
  const [mcp] = json(project, 'ard.json').entries;
  assert.deepEqual(mcp['@context'], [ARD_CONTEXT, { col: COLLECTIONS_NS }]);
  assert.deepEqual(mcp['col:memberOf'], [{ collection: 'https://traders.example/collections/demo-high-street.json', role: { category: 'farm shop' } }]);
});

test('the server card follows the v1 schema rules', () => {
  const card = json(demoProject(), 'mcp/server-card.json');
  assert.deepEqual(validateServerCard(card).map((r) => r.level), ['pass']);
  assert.equal(card.remotes[0].url, 'https://hollowlane.example/mcp');
  assert.ok(card.remotes[0].supportedProtocolVersions.includes('2026-07-28'));
  const long = demoProject();
  long.business.name = 'A'.repeat(150);
  assert.ok(json(long, 'mcp/server-card.json').description.length <= 100);
});

test('SKILL.md is a valid Agent Skill that keeps the customer in charge', () => {
  const skill = files().get('SKILL.md');
  assert.deepEqual(validateSkill(skill).map((r) => r.level), ['pass']);
  assert.match(skill, /^name: hollow-lane-farm-shop$/m);
  assert.match(skill, /Free-range eggs \(dozen\), Sourdough loaf or Seasonal veg box/);
  assert.match(skill, /\| Free-range eggs \(dozen\) \| EGG-12 \| £3\.20 per box \| 40 \| In stock \|/);
  assert.match(skill, /Tuesday to Saturday, 09:00 to 17:00/);
  assert.match(skill, /Nothing is ever ordered automatically/);
  assert.match(skill, /Adding a connector is the user's choice/);
});

test('schema.org data lists each offer with availability', () => {
  const ld = json(demoProject(), 'business.jsonld');
  assert.equal(ld['@type'], 'LocalBusiness');
  assert.equal(ld.hasOfferCatalog.itemListElement[0].price, '3.20');
  assert.equal(ld.hasOfferCatalog.itemListElement[0].availability, 'https://schema.org/InStock');
  assert.deepEqual(ld.openingHours, ['Tu-Sa 09:00-17:00']);
});

test('business text is escaped everywhere it is shown', () => {
  const project = demoProject();
  project.business.name = 'Bob & Sue\'s <script>alert(1)</script> "Shop"';
  project.catalogue.items[0].name = 'Eggs | <b>big</b>';
  const out = files(project);
  assert.doesNotMatch(out.get('index.html'), /<script>alert/);
  assert.match(out.get('index.html'), /Bob &amp; Sue's &lt;script&gt;/);
  assert.doesNotMatch(out.get('badge.svg'), /<script>alert/);
  assert.match(out.get('SKILL.md'), /Eggs \\\| <b>big<\/b>/);
  // JSON-LD inside a <script> tag must not be able to close it
  assert.doesNotMatch(out.get('index.html').split('application/ld+json">')[1].split('</script>')[0], /<\/script/i);
});

test('the badge carries the business link and the brand', () => {
  const svg = files().get('badge.svg');
  assert.match(svg, /<title id="t">Gentifi window sticker for Hollow Lane Farm Shop: scan to add us to your AI assistant \(hollowlane.example\)<\/title>/);
  assert.match(svg, />Agent-ready business</);
  assert.match(svg, />Works in Claude and ChatGPT today</);
  const card = files().get('counter-card.svg');
  assert.match(card, />Ask your AI about us</);
  assert.match(card, />Works in Claude and ChatGPT today</);
  assert.doesNotMatch(card, /on Gentifi"|Hermes|any agent/, 'signs only promise apps we have tested');
  const page = files().get('index.html');
  assert.match(page, /Add Hollow Lane Farm Shop to your AI assistant/);
  assert.match(page, /<strong>Claude:<\/strong> Settings → Connectors → Add custom connector/);
  assert.match(page, /<strong>ChatGPT:<\/strong> In a browser, not the app: <a href="https:\/\/chatgpt\.com\/plugins">chatgpt\.com\/plugins<\/a> → Add \(top right\) → Add custom MCP server/);
  assert.match(page, /Have they got free-range eggs\?/);
  assert.match(svg, /<path fill="#05414D" d="M4 4h7/);
});

test('a hand-edited item without a price does not break the build', () => {
  const project = demoProject();
  project.catalogue.items[0].price = null;
  const offer = json(project, 'business.jsonld').hasOfferCatalog.itemListElement[0];
  assert.equal(offer.price, undefined);
  assert.equal(offer.itemOffered.name, 'Free-range eggs (dozen)');
});

test('printed signs use the short link when there is one, and a bakery sheet carries allergens and notice', async () => {
  const { readSource } = await import('../src/lib/catalogue.js');
  const project = demoProject();
  project.publish = { ...project.publish, shortUrl: 'https://gentifi.com/b/hollow-lane' };
  const out = files(project);
  for (const f of ['badge.svg', 'counter-card.svg']) assert.match(out.get(f), /gentifi\.com\/b\/hollow-lane \)|gentifi\.com\/b\/hollow-lane\)/);
  assert.match(out.get('signs.html'), /Counter card, A6/);
  assert.match(out.get('counter-card.svg'), /viewBox="0 0 1050 1480"/);
  const bakery = await readSource({ type: 'csv', file: new URL('../examples/bakery-template.csv', import.meta.url).pathname });
  assert.deepEqual(bakery.problems, []);
  const cake = bakery.items.find((i) => i.sku === 'CAKE-8');
  assert.equal(cake.allergens, 'Wheat (gluten), milk, egg');
  assert.equal(cake.notice, '3 days');
  const shop = demoProject();
  shop.catalogue.items = bakery.items;
  const skill = files(shop).get('SKILL.md');
  assert.match(skill, /Order 3 days ahead/);
  assert.match(skill, /never assume it is free from anything/);
});

test('on the network connector, the scan page asks about the business by name, with copy and open links', () => {
  const project = demoProject();
  project.publish = { ...project.publish, networkUrl: 'https://mcp.gentifi.com/mcp' };
  const page = files(project).get('index.html');
  assert.match(page, /Copy the Gentifi link\. It includes Hollow Lane Farm Shop\./);
  assert.match(page, /“Using Gentifi, does Hollow Lane Farm Shop have free-range eggs\?”/);
  assert.match(page, /data-copy="Using Gentifi, does Hollow Lane Farm Shop have free-range eggs\?">Copy question</);
  assert.match(page, /href="https:\/\/claude\.ai\/new\?q=Using%20Gentifi%2C%20does%20Hollow%20Lane%20Farm%20Shop%20have%20free-range%20eggs%3F">Open Claude</);
  assert.match(page, /href="https:\/\/chatgpt\.com\/\?q=Using%20Gentifi%2C/);
  assert.doesNotMatch(page, /Have they got/, 'questions name the business when the connector covers every business');
});

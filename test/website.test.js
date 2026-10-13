import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedCrawlers, checkWebsite, pageJsonLd, websiteJsonLd, websiteSnippet } from '../src/lib/website.js';
import website from '../src/commands/website.js';
import { saveProject } from '../src/lib/project.js';
import { join } from 'node:path';
import { demoProject, withTempDir } from './helpers.js';

const project = () => {
  const p = demoProject();
  Object.assign(p.business, { name: 'Corner Bakery', telephone: '01454 000000', website: 'https://cornerbakery.example', openingHours: ['Tu-Sa 08:00-16:00'], address: { street: '1 High St', locality: 'Chipping Sodbury', postcode: 'BS37 6AA' } });
  return p;
};
const page = (data, extra = '') => `<html><head>${extra}<script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;
const levels = (results) => results.map((r) => `${r.level}: ${r.text}`);

test('the website snippet carries stable details and points to the Gentifi page for prices', () => {
  const p = project();
  const data = websiteJsonLd(p);
  assert.equal(data.name, 'Corner Bakery');
  assert.equal(data.address.postalCode, 'BS37 6AA');
  assert.deepEqual(data.openingHours, ['Tu-Sa 08:00-16:00']);
  assert.equal(data.hasOfferCatalog.itemListElement, undefined, 'no prices, so the snippet never goes stale');
  assert.match(data.hasOfferCatalog.url, /\/$/);
  const snippet = websiteSnippet(p);
  assert.match(snippet, /<link rel="ard" href="[^"]+\/ard\.json">/);
  assert.deepEqual(pageJsonLd(snippet)[0].name, 'Corner Bakery', 'the snippet parses as JSON-LD');
});

test('a website with the snippet passes the check', () => {
  const p = project();
  const results = checkWebsite(p, { html: `<html><head>${websiteSnippet(p)}</head></html>`, robots: 'User-agent: *\nAllow: /\n' });
  assert.deepEqual(results.filter((r) => r.level !== 'pass'), [], levels(results).join('\n'));
});

test('the check finds missing, out-of-date and blocked things', () => {
  const p = project();
  const none = checkWebsite(p, { html: '<html></html>', robots: '' });
  assert.ok(none.some((r) => r.level === 'fail' && /No structured data/.test(r.text)));

  const stale = checkWebsite(p, {
    html: page({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Bakery', name: 'Corner Bakery Ltd', telephone: '+44 1454 999999', address: { postalCode: 'BS37 6AA' }, openingHours: ['Mo-Sa 08:00-16:00'] }] }),
  });
  const text = levels(stale).join('\n');
  assert.match(text, /warn: Name is "Corner Bakery Ltd"/);
  assert.match(text, /warn: Phone number differs/);
  assert.match(text, /warn: Opening hours differ/);
  assert.doesNotMatch(text, /Postcode/, 'matching postcodes pass');
  assert.match(text, /warn: The page doesn't link its AI discovery file/);

  const blocked = checkWebsite(p, { html: page(websiteJsonLd(p)), robots: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n' });
  assert.ok(blocked.some((r) => r.level === 'fail' && /blocks OAI-SearchBot, PerplexityBot,/.test(r.text)));
});

test('robots.txt: a blanket block catches every crawler without its own group', () => {
  assert.deepEqual(blockedCrawlers('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n'), ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Bingbot']);
  assert.deepEqual(blockedCrawlers('User-agent: *\nDisallow:\n'), []);
});

test('gentifi website prints the snippet, and --check reports on a live site', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'gentifi.json');
    await saveProject(file, project());
    const lines = [];
    const io = { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) };
    assert.equal(await website.run({ project: file }, io), 0);
    assert.match(lines.join('\n'), /application\/ld\+json/);

    lines.length = 0;
    const fetchImpl = async (url) => ({
      ok: true,
      text: async () => (String(url).endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /\n' : '<html></html>'),
    });
    assert.equal(await website.run({ project: file, check: 'https://cornerbakery.example' }, { ...io, fetchImpl }), 1);
    const report = lines.join('\n');
    assert.match(report, /No structured data/);
    assert.match(report, /robots\.txt blocks Googlebot/);
    assert.match(report, /Google Business Profile/);
  });
});

test('a company-only Organization block is flagged, with its missing address and hours', () => {
  const results = checkWebsite(project(), { html: page({ '@type': 'Organization', name: 'Corner Bakery', url: 'https://cornerbakery.example' }) });
  const text = results.map((r) => `${r.level}: ${r.text}`).join('\n');
  assert.match(text, /warn: The structured data describes a company \(Organization\), not a shop/);
  assert.match(text, /warn: No address/);
  assert.match(text, /warn: No opening hours/);
});

test('--check --name --report works for a business not on Gentifi yet', async () => {
  await withTempDir(async (dir) => {
    const report = join(dir, 'report.html');
    const lines = [];
    const fetchImpl = async (url) => ({ ok: true, text: async () => (String(url).endsWith('/robots.txt') ? '' : page({ '@type': 'Organization', name: 'Corner Bakery' })) });
    const code = await website.run({ check: 'https://cornerbakery.example', name: 'Corner Bakery', report, project: join(dir, 'missing.json') }, { out: (l) => lines.push(l), err: (l) => lines.push(l), fetchImpl });
    assert.equal(code, 0);
    const html = await (await import('node:fs/promises')).readFile(report, 'utf8');
    assert.match(html, /How AI sees Corner Bakery/);
    assert.match(html, /describes a company \(Organization\), not a shop/);
    assert.match(html, /Google Business Profile/);
    assert.doesNotMatch(html, /\bfree\b|£|per month/i, 'no pricing in the report');
  });
});

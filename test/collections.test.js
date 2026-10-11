import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { COLLECTIONS_NS, memberManifestUrl, validateCollection, verifyMembership } from '../src/lib/collections.js';
import { ARD_CONTEXT } from '../src/lib/outputs.js';

const context = [ARD_CONTEXT, { col: COLLECTIONS_NS }];

function showDoc() {
  return {
    collection: {
      id: 'urn:air:shows.example:collection:demo-selfbuild-2027',
      name: 'Demo Self Build Show 2027',
      kind: 'event',
      publisher: { name: 'Demo Shows', domain: 'shows.example' },
      validFrom: '2027-05-14',
      validTo: '2027-05-16',
      facets: ['col:category', 'col:priceFrom', 'col:stand'],
    },
    entries: [
      {
        '@context': context,
        identifier: 'urn:air:windows.example:mcp:catalogue',
        displayName: 'Example Windows',
        type: 'application/mcp-server-card+json',
        url: 'https://windows.example/mcp/server-card.json',
        representativeQueries: ['Triple glazing under £600/m²', 'Lead time for new windows'],
        'col:stand': 'B12',
        'col:category': 'glazing',
        'col:priceFrom': { amount: 540, currency: 'GBP', unit: 'm²' },
      },
      {
        '@context': context,
        identifier: 'urn:air:heatpumps.example:mcp:catalogue',
        displayName: 'Example Heat Pumps',
        type: 'application/mcp-server-card+json',
        url: 'https://heatpumps.example/mcp/server-card.json',
        'col:stand': 'C04',
        'col:category': 'heating',
      },
    ],
  };
}

const levels = (results) => results.map((r) => r.level);
const failures = (results) => results.filter((r) => r.level === 'fail').map((r) => r.text).join('\n');

test('a well-formed event collection is valid', () => {
  const results = validateCollection(showDoc(), { servedFrom: 'https://shows.example/collections/demo-selfbuild-2027.json' });
  assert.ok(!levels(results).includes('fail'), failures(results));
  assert.match(results.map((r) => r.text).join('\n'), /Served from the publisher's own domain/);
});

test('draft 0.1 documents get a migration hint', () => {
  const old = { collection: { id: 'demo', name: 'Demo', kind: 'event', members: [{ catalog: 'https://x.example/.well-known/ai-catalog.json' }] } };
  assert.match(failures(validateCollection({ members: [] })), /draft 0.1/);
  assert.match(failures(validateCollection(old)), /collection.id must be a URN|entries must list/);
});

test('the rules catch what the schema cannot', () => {
  const doc = showDoc();
  doc.collection.kind = 'festival';
  doc.collection.validTo = '2027-05-01';
  doc.collection.attendees = [{ email: 'someone@example.com' }];
  doc.entries[1].url = 'http://heatpumps.example/card.json';
  doc.entries[0]['col:manifest'] = 'https://evil.example/ard.json';
  delete doc.entries[1]['@context'];
  const f = failures(validateCollection(doc, { servedFrom: 'https://elsewhere.example/c.json' }));
  assert.match(f, /kind must be one of/);
  assert.match(f, /validFrom must be on or before validTo/);
  assert.match(f, /Rule 2: a collection holds no customer data. Remove collection.attendees, collection.attendees\[0\].email/);
  assert.match(f, /url must be https/);
  assert.match(f, /col:manifest must be on windows.example/);
  assert.match(f, /its @context should bind col/);
  assert.match(f, /Served from elsewhere.example, not the publisher's domain shows.example/);
});

test('business details such as names are not mistaken for customer data', () => {
  assert.match(validateCollection(showDoc()).map((r) => r.text).join('\n'), /Rule 2: no customer data/);
});

test('member manifests default to the well-known path on the URN domain', () => {
  assert.equal(memberManifestUrl({ identifier: 'urn:air:windows.example:mcp:catalogue' }), 'https://windows.example/.well-known/ard.json');
  assert.equal(memberManifestUrl({ identifier: 'urn:air:host.example:mcp:shop', 'col:manifest': 'https://host.example/b/shop/ard.json' }), 'https://host.example/b/shop/ard.json');
});

test('rule 1: only members whose own manifest links back are confirmed', async () => {
  const collectionUrl = 'https://shows.example/collections/demo-selfbuild-2027.json';
  const manifests = {
    'https://windows.example/.well-known/ard.json': { entries: [{ identifier: 'urn:air:windows.example:mcp:catalogue', displayName: 'Example Windows', type: 'application/mcp-server-card+json', url: 'https://windows.example/mcp/server-card.json', 'col:memberOf': [{ collection: collectionUrl }] }] },
    'https://heatpumps.example/.well-known/ard.json': { entries: [{ identifier: 'urn:air:heatpumps.example:mcp:catalogue', displayName: 'Example Heat Pumps', type: 'application/mcp-server-card+json', url: 'https://heatpumps.example/mcp/server-card.json' }] },
  };
  const fetchImpl = async (url) => (manifests[url]
    ? new Response(JSON.stringify(manifests[url]), { headers: { 'content-type': 'application/json' } })
    : new Response('missing', { status: 404 }));
  const doc = showDoc();
  doc.entries.push({ ...doc.entries[1], identifier: 'urn:air:solar.example:mcp:catalogue', displayName: 'Example Solar' });
  const results = await verifyMembership(doc, collectionUrl, { fetchImpl });
  assert.deepEqual(results.map((r) => [r.entry.displayName, r.status]), [
    ['Example Windows', 'confirmed'],
    ['Example Heat Pumps', 'unconfirmed'],
    ['Example Solar', 'unreachable'],
  ]);
});

test('rule 1 over real HTTP, including a nested collection', async () => {
  const parentUrl = 'https://shows.example/collections/show.json';
  const server = createServer((req, res) => {
    const docs = {
      '/member.json': { entries: [{ identifier: 'urn:air:127.0.0.1:mcp:shop', displayName: 'Shop', type: 'application/mcp-server-card+json', url: 'https://x.example/c', 'col:memberOf': [{ collection: parentUrl }] }] },
      '/nested.json': { collection: { id: 'urn:air:127.0.0.1:collection:hall-b', memberOf: [{ collection: parentUrl }] }, entries: [] },
    };
    const body = docs[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const doc = {
      collection: showDoc().collection,
      entries: [
        { identifier: 'urn:air:127.0.0.1:mcp:shop', displayName: 'Shop', type: 'application/mcp-server-card+json', url: 'https://x.example/c', 'col:manifest': `${base}/member.json` },
        { identifier: 'urn:air:127.0.0.1:collection:hall-b', displayName: 'Hall B', type: 'application/ai-collection+json', url: `${base}/nested.json` },
      ],
    };
    const results = await verifyMembership(doc, parentUrl);
    assert.deepEqual(results.map((r) => r.status), ['confirmed', 'confirmed']);

    // A manifest on someone else's domain can't confirm membership
    doc.entries[0].identifier = 'urn:air:shop.example:mcp:shop';
    const [spoofed] = await verifyMembership({ ...doc, entries: [doc.entries[0]] }, parentUrl);
    assert.equal(spoofed.status, 'unconfirmed');
    assert.match(spoofed.detail, /not on shop.example/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

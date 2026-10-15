import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessProfile, openingHoursEntry, profileBusinessId } from '../src/lib/profile.js';
import { demoProject } from './helpers.js';

test('opening hours and ids follow the profile draft', () => {
  assert.deepEqual(openingHoursEntry('Tu-Sa 09:00-17:00'), { days: ['tue', 'wed', 'thu', 'fri', 'sat'], opens: '09:00', closes: '17:00' });
  assert.deepEqual(openingHoursEntry('Sa,Su 10:00-14:00').days, ['sat', 'sun']);
  assert.deepEqual(openingHoursEntry('Fr-Mo 08:00-12:00').days, ['fri', 'sat', 'sun', 'mon'], 'ranges can wrap the weekend');
  assert.equal(openingHoursEntry('by appointment'), null);
  assert.equal(profileBusinessId('hollow-lane-farm-shop'), 'gtf_hollowlanefarmshop');
  assert.equal(profileBusinessId('bake'), 'gtf_bake0000', 'short slugs are padded to 8');
  assert.match(profileBusinessId('x'.repeat(50)), /^gtf_x{32}$/);
});

test('a project becomes a profile: honest freshness, no guessed stock, the customer confirms orders', () => {
  const project = demoProject();
  project.catalogue.items[1].stock = null;
  project.catalogue.items[1].inStock = null;
  project.catalogue.items.push({ ...project.catalogue.items[0], sku: 'HAMPER', name: 'Christmas hamper', price: null, priceFrom: null, stock: 0, inStock: false });
  const p = businessProfile(project);
  assert.equal(p.spec_version, '0.1');
  assert.equal(p.business.id, 'gtf_hollowlanefarmshop');
  assert.deepEqual(p.business.location, { address: { country: 'GB' } });
  assert.deepEqual(p.offerings.map((o) => [o.id, o.price.type, o.price.amount?.amount_minor]), [['egg-12', 'fixed', 320], ['brd-sd', 'fixed', 450], ['veg-box', 'fixed', 1800], ['hamper', 'quote', undefined]]);
  assert.deepEqual(p.availability.map((r) => [r.offering_id, r.status, r.quantity]), [['egg-12', 'in_stock', 40], ['veg-box', 'in_stock', 15], ['hamper', 'out_of_stock', 0]], 'no record for an item with no stock given');
  assert.deepEqual(p.availability[0].freshness, { observed_at: project.catalogue.updatedAt, confidence: 'likely', source: 'owner' });
  assert.deepEqual(p.actions.map((a) => [a.action, a.mode, a.applies_to]), [['order', 'request_to_confirm', ['egg-12', 'brd-sd', 'veg-box']], ['enquire', 'request_to_confirm', undefined]]);
  assert.deepEqual(p.policies, {});
  assert.equal(p.extensions['com.gentifi'].schema, 'https://gentifi.com/standards/profile-0.1.schema.json');
  assert.equal(p.updated_at, project.catalogue.updatedAt);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRef, orderToken, readOrderToken } from '../src/lib/confirm.js';

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

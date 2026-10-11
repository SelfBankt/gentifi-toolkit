import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeQr, qrSvg } from '../src/lib/qr.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/qr-reference.json', import.meta.url), 'utf8'));

test('matrices match an independent implementation bit for bit', () => {
  for (const f of fixtures) {
    const qr = encodeQr(f.text, { level: f.level, version: f.version, mask: f.mask });
    const rows = qr.modules.map((row) => row.map((d) => (d ? '1' : '0')).join(''));
    assert.deepEqual(rows, f.rows, `${f.text} v${f.version} ${f.level} mask ${f.mask}`);
  }
});

test('picks the smallest version that fits', () => {
  assert.equal(encodeQr('https://gentifi.com/b/demo-business', { level: 'M' }).version, 3);
  assert.equal(encodeQr('a', { level: 'H' }).version, 1);
});

test('finder patterns sit in three corners', () => {
  const { modules, size } = encodeQr('https://gentifi.com/b/hollow-lane-farm-shop');
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[r][c], true);
    assert.equal(modules[r + 1][c + 1], false);
    assert.equal(modules[r + 3][c + 3], true);
  }
});

test('refuses text that needs more than version 10', () => {
  assert.throws(() => encodeQr('x'.repeat(400)), /too long/);
});

test('SVG output is self-contained and labelled', () => {
  const svg = qrSvg('https://gentifi.com/b/demo-business');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 37 37"/);
  assert.match(svg, /aria-label="QR code for https:\/\/gentifi.com\/b\/demo-business"/);
});

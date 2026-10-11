import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/lib/project.js';

export function capture() {
  const io = { stdout: '', stderr: '' };
  io.out = (s) => { io.stdout += s + '\n'; };
  io.err = (s) => { io.stderr += s + '\n'; };
  return io;
}

export const DEMO_CSV = new URL('../examples/demo-farm-shop.csv', import.meta.url).pathname;

export const demoItems = () => [
  { sku: 'EGG-12', name: 'Free-range eggs (dozen)', kind: 'product', category: 'Eggs and dairy', description: '', price: 3.2, priceFrom: null, currency: 'GBP', unit: 'box', stock: 40, inStock: true, availability: 'In stock', url: '' },
  { sku: 'BRD-SD', name: 'Sourdough loaf', kind: 'product', category: 'Bakery', description: '', price: 4.5, priceFrom: null, currency: 'GBP', unit: 'loaf', stock: 12, inStock: true, availability: 'Baked Fri and Sat', url: '' },
  { sku: 'VEG-BOX', name: 'Seasonal veg box', kind: 'product', category: 'Fruit and veg', description: '', price: 18, priceFrom: null, currency: 'GBP', unit: 'box', stock: 15, inStock: true, availability: 'Order by Thursday', url: '' },
];

/** The fictional demo farm shop, as "gentifi init" would create it. */
export function demoProject(overrides = {}) {
  const project = createProject({
    business: {
      name: 'Hollow Lane Farm Shop',
      kind: 'Farm shop',
      description: 'A fictional farm shop used to test the toolkit.',
      area: 'BS',
      email: 'orders@hollowlane.example',
      openingHours: ['Tu-Sa 09:00-17:00'],
    },
    ordering: { method: 'reserve' },
    items: demoItems(),
    source: { type: 'csv', file: DEMO_CSV },
    baseUrl: 'https://hollowlane.example',
    now: new Date('2026-10-11T09:00:00Z'),
  });
  return { ...project, ...overrides };
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gentifi-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SOURCES } from '../src/commands/init.js';

const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const field = (k) => frontmatter.match(new RegExp(`^${k}: (.+)$`, 'm'))?.[1];

test('SKILL.md has Agent Skills frontmatter', () => {
  const name = field('name');
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  const description = field('description');
  assert.ok(description && description.length <= 1024);
});

test('SKILL.md lists every init source', () => {
  for (const s of SOURCES) assert.match(skill, new RegExp('`' + s + '`'));
});

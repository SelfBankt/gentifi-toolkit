import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, commands } from '../src/cli.js';

function capture() {
  const io = { stdout: '', stderr: '' };
  io.out = (s) => { io.stdout += s + '\n'; };
  io.err = (s) => { io.stderr += s + '\n'; };
  return io;
}

test('help lists every command', async () => {
  const io = capture();
  assert.equal(await main([], io), 0);
  for (const name of Object.keys(commands)) assert.match(io.stdout, new RegExp(`\\b${name}\\b`));
});

test('unknown command fails', async () => {
  const io = capture();
  assert.equal(await main(['frobnicate'], io), 1);
  assert.match(io.stderr, /Unknown command/);
});

test('stub commands exit 2 with a plan', async () => {
  for (const name of Object.keys(commands)) {
    const io = capture();
    assert.equal(await main([name], io), 2, name);
    assert.match(io.stderr, /not implemented yet/);
  }
});

test('init rejects an unknown source', async () => {
  const io = capture();
  assert.equal(await main(['init', '--from', 'fax'], io), 1);
});

test('command --help exits 0', async () => {
  const io = capture();
  assert.equal(await main(['init', '--help'], io), 0);
  assert.match(io.stdout, /--from <value>/);
});

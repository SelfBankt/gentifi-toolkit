import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where payments keep their state: single-use claims (replay protection that
 * survives restarts), the order log, and the key that signs request state.
 */

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

export async function fileStore(dir) {
  await mkdir(join(dir, 'claims'), { recursive: true, mode: 0o700 });
  // The folder ignores itself, so its secrets and order log never reach a git repository
  await writeFile(join(dir, '.gitignore'), '# Created by gentifi: payment secrets and orders stay out of git\n*\n', { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  return {
    dir,
    /** Atomically records `key` as used. False if it was already used. */
    async claim(key) {
      try {
        const handle = await open(join(dir, 'claims', sha256hex(key)), 'wx', 0o600);
        await handle.writeFile(`${key}\n${new Date().toISOString()}\n`);
        await handle.close();
        return true;
      } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
      }
    },
    async addOrder(order) {
      await appendFile(join(dir, 'orders.jsonl'), JSON.stringify(order) + '\n', { mode: 0o600 });
    },
    /** A secret kept in the data directory, created on first use. */
    async secret(name) {
      const file = join(dir, name);
      try {
        return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const fresh = randomBytes(32);
      try {
        await writeFile(file, fresh.toString('hex'), { mode: 0o600, flag: 'wx' });
        return fresh;
      } catch (e) {
        if (e.code === 'EEXIST') return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
        throw e;
      }
    },
  };
}

/** In-memory store, for the Gentified test and unit tests. */
export function memoryStore() {
  const claims = new Set();
  const orders = [];
  const secrets = new Map();
  return {
    dir: null,
    orders,
    async claim(key) {
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    async addOrder(order) {
      orders.push(order);
    },
    async secret(name) {
      if (!secrets.has(name)) secrets.set(name, randomBytes(32));
      return secrets.get(name);
    },
  };
}

/** Integrity-protected request state for MCP multi round-trip requests. */
export function sealState(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function openState(secret, token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

import { createServer } from 'node:http';
import { verifyEvent } from './nostr.js';
import { acceptKey, encodeFrame, messageReader } from './websocket.js';

/**
 * A minimal in-memory Nostr relay (NIP-01) for development and tests: it checks
 * signatures, stores regular and replaceable events, forwards ephemeral ones
 * (NWC requests and responses) without storing them, and answers subscriptions.
 * It is not meant for the open internet.
 */

const isEphemeral = (kind) => kind >= 20000 && kind < 30000;
const isReplaceable = (kind) => kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

export async function startRelay({ port = 0, host = '127.0.0.1' } = {}) {
  const stored = [];
  const clients = new Set();
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This is a Nostr relay. Connect with a WebSocket.');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const client = { socket, subs: new Map() };
    clients.add(client);
    const send = (message) => socket.write(encodeFrame(1, Buffer.from(JSON.stringify(message), 'utf8'), false));
    client.send = send;

    const handle = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        send(['NOTICE', 'invalid: not JSON']);
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT') {
        const event = msg[1];
        if (!verifyEvent(event)) {
          send(['OK', event?.id ?? '', false, 'invalid: bad signature or id']);
          return;
        }
        if (!isEphemeral(event.kind)) {
          if (isReplaceable(event.kind)) {
            for (let i = stored.length - 1; i >= 0; i -= 1) {
              if (stored[i].kind === event.kind && stored[i].pubkey === event.pubkey) stored.splice(i, 1);
            }
          }
          stored.push(event);
        }
        send(['OK', event.id, true, '']);
        for (const other of clients) {
          for (const [subId, filters] of other.subs) {
            if (filters.some((f) => matches(f, event))) other.send(['EVENT', subId, event]);
          }
        }
      } else if (msg[0] === 'REQ') {
        const [, subId, ...filters] = msg;
        client.subs.set(subId, filters);
        for (const f of filters) {
          const found = stored.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at);
          for (const e of f.limit ? found.slice(0, f.limit) : found) send(['EVENT', subId, e]);
        }
        send(['EOSE', subId]);
      } else if (msg[0] === 'CLOSE') {
        client.subs.delete(msg[1]);
      }
    };

    socket.on('data', messageReader((opcode, payload) => {
      if (opcode === 1) handle(payload.toString('utf8'));
      else if (opcode === 9) socket.write(encodeFrame(10, payload, false));
      else if (opcode === 8) socket.end(encodeFrame(8, Buffer.alloc(0), false));
    }));
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const { port: actual } = server.address();
  return {
    url: `ws://${host}:${actual}`,
    close: () => new Promise((resolve) => {
      for (const c of clients) c.socket.destroy();
      server.close(() => resolve());
    }),
  };
}

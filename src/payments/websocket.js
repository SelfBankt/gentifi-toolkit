import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A small WebSocket (RFC 6455) client and the framing a test relay needs, so
 * Nostr Wallet Connect works on Node 20 without dependencies. Text messages
 * only; pings are answered.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

export function encodeFrame(opcode, payload, mask) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);
  const key = randomBytes(4);
  return Buffer.concat([header, key, Buffer.from(data.map((b, i) => b ^ key[i % 4]))]);
}

/** Feeds raw bytes in and calls `onMessage(opcode, payload)` for each complete message. */
export function messageReader(onMessage) {
  let buf = Buffer.alloc(0);
  let fragments = null;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const keyLen = masked ? 4 : 0;
      if (buf.length < off + keyLen + len) return;
      let payload = buf.subarray(off + keyLen, off + keyLen + len);
      if (masked) {
        const key = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(off + keyLen + len);
      if (opcode >= 8) {
        onMessage(opcode, payload); // control frames are never fragmented
      } else if (opcode !== 0 && fin) {
        onMessage(opcode, payload);
      } else if (opcode !== 0) {
        fragments = { opcode, parts: [payload] };
      } else if (fragments) {
        fragments.parts.push(payload);
        if (fin) {
          onMessage(fragments.opcode, Buffer.concat(fragments.parts));
          fragments = null;
        }
      }
    }
  };
}

/**
 * Opens a WebSocket. Resolves to { send(text), close(), onMessage(fn), onClose(fn) }.
 */
export function connectWebSocket(url, { timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`Not a WebSocket URL: ${url}`);
  const key = randomBytes(16).toString('base64');
  const send = u.protocol === 'wss:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: `${u.pathname || '/'}${u.search}`,
      servername: u.hostname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      timeout: timeoutMs,
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out connecting to ${url}`)));
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`${url} refused the WebSocket upgrade (HTTP ${res.statusCode})`)));
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new Error(`${url} sent a bad WebSocket handshake`));
        return;
      }
      socket.setTimeout(0);
      const listeners = new Set();
      const closers = new Set();
      let open = true;
      const finish = () => {
        if (!open) return;
        open = false;
        for (const fn of closers) fn();
      };
      const read = messageReader((opcode, payload) => {
        if (opcode === 1) for (const fn of listeners) fn(payload.toString('utf8'));
        else if (opcode === 9) socket.write(encodeFrame(10, payload, true));
        else if (opcode === 8) {
          socket.end(encodeFrame(8, Buffer.alloc(0), true));
          finish();
        }
      });
      socket.on('data', read);
      socket.on('close', finish);
      socket.on('error', finish);
      if (head?.length) read(head);
      resolve({
        send: (text) => {
          if (!open) throw new Error('WebSocket is closed');
          socket.write(encodeFrame(1, Buffer.from(text, 'utf8'), true));
        },
        close: () => {
          if (open) socket.end(encodeFrame(8, Buffer.alloc(0), true));
          finish();
          socket.destroy();
        },
        onMessage: (fn) => listeners.add(fn),
        onClose: (fn) => closers.add(fn),
      });
    });
    req.end();
  });
}

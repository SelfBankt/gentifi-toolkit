import { createServer } from 'node:http';
import { ERRORS, RpcError, SUPPORTED_VERSIONS, errorResponse, isNotification, requestedVersion } from './protocol.js';

const MAX_BODY = 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CORS_HEADERS = 'content-type, accept, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id';

const TYPES = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonld: 'application/ld+json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};

export function contentType(path) {
  return TYPES[path.split('.').pop()] ?? 'application/octet-stream';
}

/** Header values may be sent as =?base64?...?= when they aren't plain ASCII. */
export function decodeHeaderValue(value) {
  const m = /^=\?base64\?(.*)\?=$/.exec(value ?? '');
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : value;
}

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...(isJson ? { 'content-type': TYPES.json } : {}),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Serves the MCP endpoint (POST), the server card and the generated files.
 * @param {{ protocol: object, files?: Map<string, string>, mcpPath?: string, allowedOrigins?: string[], log?: (s: string) => void }} options
 */
export function createHttpHandler({ protocol, files = new Map(), mcpPath = '/mcp', allowedOrigins = [], log = () => {} }) {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));

  function originAllowed(origin, host) {
    if (!origin) return true; // not a browser request
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    return allowed.has(url.origin) || LOCAL_HOSTS.has(url.hostname) || url.host === host;
  }

  async function handleMcp(req, res, cors) {
    if (!/application\/json/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, errorResponse(null, new RpcError(ERRORS.invalidRequest, 'Content-Type must be application/json')), cors);
    }
    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch (e) {
      if (e.status === 413) return send(res, 413, errorResponse(null, new RpcError(ERRORS.invalidRequest, e.message)), cors);
      return send(res, 400, errorResponse(null, new RpcError(ERRORS.parse, 'Parse error')), cors);
    }
    if (Array.isArray(message)) {
      return send(res, 400, errorResponse(null, new RpcError(ERRORS.invalidRequest, 'Batched requests are not supported')), cors);
    }

    const version = requestedVersion(message);
    const modern = version !== undefined && message?.method !== 'initialize';
    const headerVersion = req.headers['mcp-protocol-version'];

    if (modern) {
      // Headers mirror the body so gateways can route on them; they must agree.
      const mismatch = (what) => send(res, 400, errorResponse(message.id ?? null, new RpcError(ERRORS.headerMismatch, `Header mismatch: ${what}`)), cors);
      if (headerVersion !== version) return mismatch(`MCP-Protocol-Version "${headerVersion ?? ''}" does not match "${version}"`);
      if (req.headers['mcp-method'] !== message.method) return mismatch(`Mcp-Method "${req.headers['mcp-method'] ?? ''}" does not match "${message.method}"`);
      const named = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' }[message.method];
      if (named && decodeHeaderValue(req.headers['mcp-name']) !== message.params?.[named]) {
        return mismatch(`Mcp-Name does not match params.${named}`);
      }
    } else if (headerVersion && !SUPPORTED_VERSIONS.includes(headerVersion)) {
      return send(res, 400, errorResponse(message?.id ?? null, new RpcError(ERRORS.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: headerVersion })), cors);
    }

    if (isNotification(message)) {
      res.writeHead(202, cors);
      return res.end();
    }

    const { era, response } = await protocol.handle(message);
    let status = 200;
    if (era === 'modern' && response.error) {
      if (response.error.code === ERRORS.unsupportedVersion) status = 400;
      if (response.error.code === ERRORS.methodNotFound) status = 404;
    }
    if (response.error?.code === ERRORS.internal) log(`Internal error handling ${message.method}`);
    return send(res, status, response, cors);
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'Bad request\n', { 'content-type': TYPES.txt });
    }
    const origin = req.headers.origin;
    if (!originAllowed(origin, req.headers.host)) {
      return send(res, 403, errorResponse(null, new RpcError(ERRORS.invalidRequest, 'Origin not allowed')));
    }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': CORS_HEADERS,
          'access-control-max-age': '600',
        });
        return res.end();
      }

      if (path === mcpPath) {
        if (req.method === 'POST') return await handleMcp(req, res, cors);
        return send(res, 405, '', { ...cors, allow: 'POST, OPTIONS' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { allow: 'GET, HEAD' });

      const key = path === `${mcpPath}/server-card` ? 'mcp/server-card.json'
        : path === '/' ? 'index.html'
          : path.replace(/^\/+/, '').replace(/\/$/, '/index.html');
      const body = files.get(key);
      if (body === undefined) return send(res, 404, 'Not found\n', { 'content-type': TYPES.txt });
      res.writeHead(200, {
        'content-type': contentType(key),
        'cache-control': 'public, max-age=300',
        // Public, read-only metadata: any origin may read it.
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      log(`Error serving ${req.method} ${path}: ${e.message}`);
      if (!res.headersSent) send(res, 500, errorResponse(null, new RpcError(ERRORS.internal, 'Internal error')), cors);
      else res.end();
    }
  };
}

export function createHttpServer(options) {
  return createServer(createHttpHandler(options));
}

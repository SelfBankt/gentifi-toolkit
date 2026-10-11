import { ERRORS, LEGACY_VERSIONS, META, MODERN_VERSIONS } from './protocol.js';

/**
 * A minimal MCP client over Streamable HTTP, for "gentifi check --url".
 * It tries the modern protocol first and falls back to the legacy initialize
 * handshake when the server doesn't recognise it, per the 2026-07-28
 * backward-compatibility rules.
 */

const CLIENT_INFO = { name: 'gentifi-check', version: '1' };
const MODERN_ERROR_CODES = new Set([ERRORS.unsupportedVersion, ERRORS.headerMismatch, -32021, ERRORS.methodNotFound]);

/** Reads a JSON response, or the matching message from an SSE stream. */
async function readJsonRpc(res, id) {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      } catch { /* ignore keep-alives and partial events */ }
    }
    return null;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export class McpHttpClient {
  constructor(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.url = url;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.era = null;
    this.version = null;
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(body, headers) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return res;
  }

  modernRequest(method, params = {}) {
    const id = this.nextId++;
    const version = MODERN_VERSIONS[0];
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: { [META.protocolVersion]: version, [META.clientInfo]: CLIENT_INFO, [META.clientCapabilities]: {} },
      },
    };
    const headers = { 'mcp-protocol-version': version, 'mcp-method': method };
    if (method === 'tools/call') headers['mcp-name'] = /^[\x20-\x7e]*$/.test(params.name) ? params.name : `=?base64?${Buffer.from(params.name).toString('base64')}?=`;
    return { id, body, headers };
  }

  /** Works out which era the server speaks. Returns 'modern' or 'legacy'. */
  async connect() {
    const { id, body, headers } = this.modernRequest('server/discover');
    const res = await this.post(body, headers);
    const msg = await readJsonRpc(res, id);
    if (res.ok && msg?.result) {
      this.era = 'modern';
      this.version = MODERN_VERSIONS[0];
      this.discover = msg.result;
      return this.era;
    }
    if (msg?.error && MODERN_ERROR_CODES.has(msg.error.code) && msg.error.code !== ERRORS.methodNotFound) {
      const supported = msg.error.data?.supported ?? [];
      throw new Error(`Server speaks a modern MCP version this client doesn't support (${supported.join(', ') || 'unknown'})`);
    }
    // Anything else: a legacy server. Fall back to initialize.
    const initId = this.nextId++;
    const initRes = await this.post({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO },
    }, {});
    const init = await readJsonRpc(initRes, initId);
    if (!initRes.ok || !init?.result) {
      throw new Error(`MCP endpoint did not answer server/discover or initialize (HTTP ${initRes.status})`);
    }
    this.era = 'legacy';
    this.version = init.result.protocolVersion;
    this.sessionId = initRes.headers.get('mcp-session-id');
    this.discover = init.result;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': this.version });
    return this.era;
  }

  /** Sends one request and returns its result, throwing on JSON-RPC errors. */
  async request(method, params = {}) {
    if (!this.era) await this.connect();
    let id;
    let res;
    if (this.era === 'modern') {
      const r = this.modernRequest(method, params);
      id = r.id;
      res = await this.post(r.body, r.headers);
    } else {
      id = this.nextId++;
      res = await this.post({ jsonrpc: '2.0', id, method, params }, { 'mcp-protocol-version': this.version });
    }
    const msg = await readJsonRpc(res, id);
    if (!msg) throw new Error(`No JSON-RPC response to ${method} (HTTP ${res.status})`);
    if (msg.error) throw Object.assign(new Error(`${method}: ${msg.error.message}`), { rpc: msg.error });
    return msg.result;
  }
}

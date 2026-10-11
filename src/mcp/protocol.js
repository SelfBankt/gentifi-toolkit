import { ToolError, validateArgs } from './tools.js';
import { InputRequired, ToolResult } from './results.js';

/**
 * A dual-era MCP server core (transport independent).
 *
 * Modern clients (protocol 2026-07-28) send their version in every request's
 * _meta and never call initialize; servers answer server/discover. Legacy
 * clients (2025-11-25 and earlier) open with initialize. Both are served, as
 * the 2026-07-28 "Versioning and Compatibility" page describes.
 */

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};

export const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
};

const LIST_TTL_MS = 5 * 60 * 1000;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The protocol version a modern request declares, or undefined for legacy traffic. */
export function requestedVersion(message) {
  return message?.params?._meta?.[META.protocolVersion];
}

export function isNotification(message) {
  return message && typeof message === 'object' && !('id' in message);
}

/**
 * @param {{ serverInfo: { name: string, version: string, title?: string }, instructions?: string, tools: Array<object>, log?: (s: string) => void }} options
 */
export function createProtocol({ serverInfo, instructions, tools, log = () => {} }) {
  const definitions = tools.map(({ handler, ...definition }) => definition); // stable order
  const byName = new Map(tools.map((t) => [t.name, t]));
  const capabilities = { tools: { listChanged: false } };

  async function callTool(params, era) {
    const tool = byName.get(params?.name);
    if (!tool) throw new RpcError(ERRORS.invalidParams, `Unknown tool: ${params?.name}`);
    const args = params.arguments ?? {};
    const problems = validateArgs(tool.inputSchema, args);
    if (problems.length) {
      return { content: [{ type: 'text', text: `Invalid arguments: ${problems.join('; ')}` }], isError: true };
    }
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
    const context = {
      era,
      meta,
      clientCapabilities: meta[META.clientCapabilities] ?? {},
      inputResponses: params.inputResponses,
      requestState: params.requestState,
    };
    try {
      const out = await tool.handler(args, context);
      if (out instanceof InputRequired) {
        if (era !== 'modern') {
          return { content: [{ type: 'text', text: 'This step needs the customer to confirm in their app, which this connection cannot show.' }], isError: true };
        }
        return {
          resultType: 'input_required',
          ...(out.inputRequests ? { inputRequests: out.inputRequests } : {}),
          ...(out.requestState ? { requestState: out.requestState } : {}),
        };
      }
      if (out instanceof ToolResult) return out.result;
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (e) {
      if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
      throw e;
    }
  }

  async function modern(method, params) {
    switch (method) {
      case 'server/discover':
        return {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities,
          ...(instructions ? { instructions } : {}),
          ttlMs: LIST_TTL_MS,
          cacheScope: 'public',
        };
      case 'tools/list':
        return { tools: definitions, ttlMs: LIST_TTL_MS, cacheScope: 'public' };
      case 'tools/call':
        return callTool(params, 'modern');
      default:
        throw new RpcError(ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  async function legacy(method, params) {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities,
          serverInfo,
          ...(instructions ? { instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: definitions };
      case 'tools/call':
        return callTool(params, 'legacy');
      default:
        throw new RpcError(ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  /**
   * Handles one JSON-RPC message.
   * Returns { era, response } where response is null for notifications.
   */
  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { era: 'unknown', response: errorResponse(message?.id ?? null, new RpcError(ERRORS.invalidRequest, 'Invalid JSON-RPC request')) };
    }
    const version = requestedVersion(message);
    const era = version !== undefined && message.method !== 'initialize' ? 'modern' : 'legacy';
    if (isNotification(message)) return { era, response: null };

    try {
      if (era === 'modern') {
        if (!MODERN_VERSIONS.includes(version)) {
          throw new RpcError(ERRORS.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: version });
        }
        const result = await modern(message.method, message.params);
        return {
          era,
          response: {
            jsonrpc: '2.0',
            id: message.id,
            result: { resultType: 'complete', ...result, _meta: { ...result._meta, [META.serverInfo]: serverInfo } },
          },
        };
      }
      return { era, response: { jsonrpc: '2.0', id: message.id, result: await legacy(message.method, message.params) } };
    } catch (e) {
      if (!(e instanceof RpcError)) log(`Error in ${message.method}: ${e.stack ?? e}`);
      return { era, response: errorResponse(message.id, e) };
    }
  }

  return { handle, definitions, serverInfo };
}

export function errorResponse(id, e) {
  const known = e instanceof RpcError;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: known ? e.code : ERRORS.internal,
      message: known ? e.message : 'Internal error',
      ...(known && e.data !== undefined ? { data: e.data } : {}),
    },
  };
}

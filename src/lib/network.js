import { businessTools, searchItems, tokens, ToolError } from '../mcp/tools.js';
import { ToolResult } from '../mcp/results.js';
import { SUPPORTED_VERSIONS } from '../mcp/protocol.js';
import { SERVER_CARD_SCHEMA } from './outputs.js';

/**
 * The Gentifi network connector: one MCP server that reaches every hosted
 * business, so a customer adds Gentifi once instead of one connector per shop.
 * find_businesses finds a shop; the other tools are each shop's own tools with
 * a `business` argument saying which shop. Businesses are looked up on every
 * call, so shops added to or removed from the host need no restart.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const BUSINESS_ARG = {
  type: 'string',
  description: 'Which business: the id from find_businesses, or the business name as the customer said it, e.g. "Hollow Lane Farm"',
};

export const NETWORK_INSTRUCTIONS = 'Gentifi connects you to independent local businesses using their own catalogues. '
  + 'When the customer names a business or asks for something local, use find_businesses first, then pass its id as business to the other tools. '
  + 'Prices and stock can change: say when they were last updated. '
  + 'Nothing is ordered through this server. prepare_order returns a summary and a link: show the customer the summary and let them confirm with the business themselves.';

const words = (b) => tokens([b.name, b.project.business.kind, b.project.business.area, b.project.business.address?.locality, b.project.business.description].join(' '));

/** Finds a business by id or by name. Several close matches is an error that lists them. */
export function resolveBusiness(businesses, ref) {
  const want = String(ref ?? '').trim();
  const all = [...businesses.values()];
  const exact = businesses.get(want.toLowerCase()) ?? all.find((b) => b.name.toLowerCase() === want.toLowerCase());
  if (exact) return exact;
  const asked = tokens(want);
  const scored = all
    .map((b) => {
      const name = tokens(b.name);
      return { b, hits: asked.filter((w) => name.includes(w)).length };
    })
    .filter((s) => s.hits > 0)
    .sort((x, y) => y.hits - x.hits);
  if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) return scored[0].b;
  if (scored.length) {
    throw new ToolError(`More than one business matches "${want}": ${scored.map((s) => `${s.b.name} (id ${s.b.slug})`).join(', ')}. Ask the customer which one.`);
  }
  throw new ToolError(`No business on Gentifi matches "${want}". Use find_businesses to search.`);
}

/** The network connector's MCP Server Card, so clients can find it before connecting. */
export function networkCard(baseUrl, version) {
  const host = new URL(baseUrl).hostname.split('.').reverse().join('.');
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: `${host}/network`,
    version,
    title: 'Gentifi',
    description: 'Independent local businesses: their products, prices, stock, opening times and ordering',
    websiteUrl: 'https://gentifi.com/connector',
    remotes: [{ type: 'streamable-http', url: `${baseUrl}/mcp`, supportedProtocolVersions: SUPPORTED_VERSIONS }],
    _meta: { 'com.gentifi/generator': `gentifi-toolkit ${version}` },
  };
}

export function networkTools(businesses, { baseUrl = '', stats = null } = {}) {
  const findTool = {
    name: 'find_businesses',
    title: 'Find businesses on Gentifi',
    description: 'Find independent businesses on Gentifi by name, place, kind of business or what they sell. Returns each business id for the other tools. Leave query empty to list them all.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A business name, place or what the customer wants, e.g. "Hollow Lane", "bakery" or "eggs"' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most results to return (default 10)' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { businesses: { type: 'array' }, total: { type: 'integer' } }, required: ['businesses', 'total'] },
    annotations: { title: 'Find businesses on Gentifi', ...READ_ONLY },
    handler: ({ query = '', limit = 10 }) => {
      const asked = tokens(query);
      const results = [...businesses.values()]
        .map((b) => {
          const own = words(b);
          const items = searchItems(b.project.catalogue.items, query);
          const score = asked.filter((w) => own.includes(w)).length * 3 + (asked.length ? items.reduce((n, r) => n + r.score, 0) : 0);
          return { b, score, items: asked.length ? items.slice(0, 5).map((r) => r.item.name) : [] };
        })
        .filter((r) => !asked.length || r.score > 0)
        .sort((x, y) => y.score - x.score || x.b.name.localeCompare(y.b.name));
      const shown = results.slice(0, limit);
      for (const { b } of shown) stats?.count(b.slug, 'searchAppearances');
      return {
        businesses: shown.map(({ b, items }) => ({
          id: b.slug,
          name: b.name,
          kind: b.project.business.kind || undefined,
          area: b.project.business.address?.locality || b.project.business.area || undefined,
          description: b.project.business.description || undefined,
          matchingItems: items.length ? items : undefined,
          page: baseUrl ? `${baseUrl}/b/${b.slug}/` : undefined,
        })),
        total: results.length,
      };
    },
  };

  // Each shop's tools, defined once from a stand-in business so the list never changes
  const template = businessTools({ business: { name: 'the business', currency: 'GBP' }, catalogue: { items: [], updatedAt: '' } });
  const shopTools = template.map((t) => ({
    name: t.name,
    title: t.title.replace('the business', 'a business'),
    description: `${t.description} Say which business with business.`,
    inputSchema: {
      ...t.inputSchema,
      properties: { business: BUSINESS_ARG, ...t.inputSchema.properties },
      required: ['business', ...(t.inputSchema.required ?? [])],
    },
    outputSchema: t.outputSchema,
    annotations: { ...t.annotations, title: t.annotations.title.replace('the business', 'a business') },
    handler: async ({ business, ...args }, context) => {
      const b = resolveBusiness(businesses, business);
      stats?.count(b.slug, 'toolCalls');
      const tool = b.tools.find((x) => x.name === t.name);
      const out = await tool.handler(args, context);
      return out && typeof out === 'object' && !(out instanceof ToolResult) && !Array.isArray(out)
        ? { business: b.name, businessId: b.slug, ...out }
        : out;
    },
  }));

  return [findTool, ...shopTools];
}

/**
 * An NLWeb-style answer to a natural-language question: GET or POST /ask with
 * query (and optionally site, a business id). Results come from the same
 * search the tools use, with no language model involved, as schema.org
 * objects. Only NLWeb's non-streaming list mode is offered.
 */
export function nlwebAsk(businesses, { query = '', site, baseUrl = '', limit = 10, stats = null } = {}) {
  const asked = tokens(query);
  const shops = [...businesses.values()].filter((b) => !site || b.slug === site);
  const results = [];
  for (const b of shops) {
    const biz = b.project.business;
    const page = `${baseUrl}/b/${b.slug}/`;
    const own = asked.filter((w) => words(b).includes(w)).length;
    if (own) {
      results.push({
        url: biz.website || page,
        name: b.name,
        site: b.slug,
        score: own * 3,
        description: biz.description || [biz.kind, biz.area].filter(Boolean).join(', ') || b.name,
        schema_object: { '@context': 'https://schema.org', '@type': biz.schemaType || 'LocalBusiness', name: b.name, url: biz.website || page, ...(biz.openingHours?.length ? { openingHours: biz.openingHours } : {}) },
      });
    }
    for (const { item, score } of asked.length ? searchItems(b.project.catalogue.items, query) : []) {
      results.push({
        url: item.url || page,
        name: item.name,
        site: b.slug,
        score: score + own,
        description: `${item.name} at ${b.name}${item.description ? `: ${item.description}` : ''}`,
        schema_object: {
          '@context': 'https://schema.org',
          '@type': item.kind === 'service' ? 'Service' : 'Product',
          name: item.name,
          ...(item.category ? { category: item.category } : {}),
          offers: {
            '@type': 'Offer',
            ...(typeof item.price === 'number' ? { price: item.price.toFixed(2), priceCurrency: item.currency || biz.currency || 'GBP' } : {}),
            ...(typeof item.stock === 'number' ? { availability: item.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' } : {}),
            seller: { '@type': biz.schemaType || 'LocalBusiness', name: b.name, url: page },
          },
        },
      });
    }
  }
  results.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
  for (const slug of new Set(results.slice(0, limit).map((r) => r.site))) stats?.count(slug, 'searchAppearances');
  return { query_id: `gentifi-${Date.now().toString(36)}`, query, results: results.slice(0, limit) };
}

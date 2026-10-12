import { generateOutputs, serverInfo, serverInstructions } from './outputs.js';
import { ORDER_METHODS, baseUrl, isLocalUrl, mcpUrl, publisherHost } from './project.js';
import { findInstructions, projectTextFields } from './safety.js';
import { validateArdManifest, validateServerCard, validateSkill } from './validate.js';
import { createProtocol, META, MODERN_VERSIONS, LEGACY_VERSIONS } from '../mcp/protocol.js';
import { businessTools } from '../mcp/tools.js';
import { McpHttpClient } from '../mcp/client.js';
import { EVM_TEST_NETWORKS, createPayments, paymentProblems } from '../payments/runtime.js';
import { randomPrivateKey } from '../payments/lightning.js';
import { memoryStore } from '../payments/store.js';
import { payOrderTool } from '../payments/tool.js';
import { decodeInvoice } from '../payments/bolt11.js';
import { MCP_PAYMENT_KEY, isLnbtc, mcpRequestHash, signEvmPayment, transferMethodOf } from '../payments/x402.js';

/**
 * The Gentified test: can agents find the business, read its prices, and
 * reach an order that the customer confirms? Results are grouped for display:
 * { group, level: 'pass' | 'warn' | 'fail' | 'info', text }.
 */

const SECRET = /\b(shpat_[a-f0-9]{16,}|shpss_[a-f0-9]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const DAY = 24 * 60 * 60 * 1000;

function grouped(group, results) {
  return results.map((r) => ({ group, ...r }));
}

function businessChecks(project) {
  const b = project.business;
  const o = project.ordering ?? {};
  const r = [];
  r.push(b.name ? { level: 'pass', text: `Name: ${b.name}` } : { level: 'fail', text: 'Add the business name' });
  r.push(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug ?? '') && b.slug.length <= 64
    ? { level: 'pass', text: `Link name: ${b.slug}` }
    : { level: 'fail', text: 'business.slug must be lower-case letters, numbers and single hyphens (at most 64)' });
  if (!b.kind) r.push({ level: 'warn', text: 'Say what kind of business it is (for example "Farm shop"), so agents can match local requests' });
  if (!b.description) r.push({ level: 'warn', text: 'Add a one-line description in your own words' });
  if (!b.area && !b.address?.postcode) r.push({ level: 'warn', text: 'Add a postcode area, so "near me" requests can find you' });
  if (!b.openingHours?.length) r.push({ level: 'warn', text: 'Add opening hours (for example "Mo-Fr 09:00-17:00")' });

  if (!o.method) {
    r.push({ level: 'fail', text: 'Say how customers order: a checkout link, a booking page, or an email or phone number for reservations' });
  } else if (!ORDER_METHODS.includes(o.method)) {
    r.push({ level: 'fail', text: `Unknown ordering method "${o.method}". Use one of: ${ORDER_METHODS.join(', ')}` });
  } else {
    const needs = {
      checkout: o.checkoutUrl || project.catalogue.items.every((i) => i.url) ? null : 'a checkout link (--checkout-url) or a url for every item',
      booking: o.bookingUrl ? null : 'a booking page link (--booking-url)',
      reserve: b.email || b.telephone ? null : 'an email address or phone number for reservations',
      quote: b.email || b.telephone ? null : 'an email address or phone number for quote requests',
    }[o.method];
    r.push(needs ? { level: 'fail', text: `Ordering by ${o.method} needs ${needs}` } : { level: 'pass', text: `Customers order by: ${o.method}` });
  }
  for (const [label, url] of [['Website', b.website], ['Checkout link', o.checkoutUrl], ['Booking link', o.bookingUrl]]) {
    if (url && !/^https:\/\//.test(url)) r.push({ level: 'warn', text: `${label} should start with https://` });
  }
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) r.push({ level: 'fail', text: `"${b.email}" doesn't look like an email address` });
  return r;
}

function catalogueChecks(project, now) {
  const items = project.catalogue.items;
  const r = [];
  if (!items.length) return [{ level: 'fail', text: 'The catalogue has no items' }];
  r.push({ level: 'pass', text: `${items.length} item${items.length === 1 ? '' : 's'} in the catalogue` });
  const skus = new Set();
  const dupes = items.filter((i) => (skus.has(i.sku) ? true : (skus.add(i.sku), false)));
  if (dupes.length) r.push({ level: 'fail', text: `Duplicate SKUs: ${[...new Set(dupes.map((i) => i.sku))].join(', ')}` });
  const badPrice = items.filter((i) => {
    const p = i.price ?? i.priceFrom;
    return typeof p !== 'number' || !Number.isFinite(p) || p < 0;
  });
  if (badPrice.length) r.push({ level: 'fail', text: `Items without a valid price: ${badPrice.map((i) => i.name).join(', ')}` });
  else r.push({ level: 'pass', text: 'Every item has a price' });
  if (!items.some((i) => typeof i.stock === 'number' || typeof i.inStock === 'boolean')) {
    r.push({ level: 'warn', text: 'No stock levels: agents can\'t tell customers what\'s in stock' });
  }
  const age = (now - new Date(project.catalogue.updatedAt)) / DAY;
  if (age > 7) r.push({ level: 'warn', text: `Prices and stock were last updated ${Math.floor(age)} days ago. Run "gentifi sync"` });
  return r;
}

function safetyChecks(project) {
  const findings = findInstructions(projectTextFields(project));
  const r = findings.map((f) => ({ level: 'fail', text: `${f.where} ${f.why}: "${f.excerpt}"` }));
  if (!findings.length) r.push({ level: 'pass', text: 'Information, not instructions: no business text tells agents what to do' });
  if (SECRET.test(JSON.stringify(project))) r.push({ level: 'fail', text: 'gentifi.json seems to contain a secret key or token. Keep secrets in environment variables' });
  return r;
}

function fileChecks(project, files) {
  const r = [];
  const parse = (path) => {
    try {
      return JSON.parse(files.get(path));
    } catch {
      r.push({ level: 'fail', text: `${path} is not valid JSON` });
      return null;
    }
  };
  const manifest = parse('.well-known/ard.json');
  if (manifest) r.push(...validateArdManifest(manifest, { expectHost: publisherHost(project) }));
  const card = parse('mcp/server-card.json');
  if (card) r.push(...validateServerCard(card));
  r.push(...validateSkill(files.get('SKILL.md')));
  const ld = parse('business.jsonld');
  if (ld) {
    const offers = ld.hasOfferCatalog?.itemListElement?.length ?? 0;
    r.push(ld['@context'] === 'https://schema.org' && ld['@type'] && offers === project.catalogue.items.length
      ? { level: 'pass', text: `schema.org ${ld['@type']} with ${offers} offer${offers === 1 ? '' : 's'}` }
      : { level: 'fail', text: 'business.jsonld is missing its schema.org type or offers' });
  }
  r.push(/<path fill="#05414D" d="M/.test(files.get('badge.svg') ?? '')
    ? { level: 'pass', text: `Badge with a scannable code for ${baseUrl(project)}` }
    : { level: 'fail', text: 'badge.svg has no QR code' });
  r.push(files.get('index.html')?.includes('rel="ard"')
    ? { level: 'pass', text: 'Scan-to-add page links to the discovery manifest' }
    : { level: 'fail', text: 'index.html does not link to ard.json' });
  if (project.a2a?.url) {
    const agentCard = parse('.well-known/agent-card.json');
    if (agentCard) r.push({ level: 'pass', text: `A2A agent card for ${project.a2a.url}` });
  }
  return r;
}

/** Calls the business's own MCP tools in-process, as an agent would. */
async function agentChecks(project, toolkitVersion) {
  const r = [];
  const protocol = createProtocol({ serverInfo: serverInfo(project, toolkitVersion), instructions: serverInstructions(project), tools: businessTools(project) });
  const meta = { [META.protocolVersion]: MODERN_VERSIONS[0], [META.clientInfo]: { name: 'gentifi-check', version: '1' }, [META.clientCapabilities]: {} };
  let id = 1;
  const modern = async (method, params = {}) => (await protocol.handle({ jsonrpc: '2.0', id: id++, method, params: { ...params, _meta: meta } })).response;

  const discover = await modern('server/discover');
  r.push(discover.result?.resultType === 'complete'
    ? { level: 'pass', text: `MCP ${MODERN_VERSIONS[0]}: server/discover answers` }
    : { level: 'fail', text: 'server/discover failed' });
  const legacy = (await protocol.handle({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: 'gentifi-check', version: '1' } } })).response;
  r.push(legacy.result?.protocolVersion === LEGACY_VERSIONS[0]
    ? { level: 'pass', text: `Older agents (MCP ${LEGACY_VERSIONS[0]}) can connect too` }
    : { level: 'fail', text: 'Legacy initialize failed' });

  const tools = (await modern('tools/list')).result?.tools ?? [];
  const unlabelled = tools.filter((t) => !t.title || (t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined));
  r.push(unlabelled.length
    ? { level: 'fail', text: `Tools need a title and readOnlyHint or destructiveHint: ${unlabelled.map((t) => t.name).join(', ')}` }
    : { level: 'pass', text: `${tools.length} tools, each with a title and safety hints (connector directories ask for both)` });

  const call = async (name, args) => (await modern('tools/call', { name, arguments: args })).result;
  const unfindable = [];
  for (const item of project.catalogue.items) {
    const res = await call('search_catalogue', { query: item.name, limit: 50 });
    if (!res.structuredContent?.items?.some((i) => i.sku === item.sku)) unfindable.push(item.name);
  }
  r.push(unfindable.length
    ? { level: 'fail', text: `Agents can't find these by name: ${unfindable.join(', ')}` }
    : { level: 'pass', text: 'Agents can find every item by name' });

  const first = project.catalogue.items[0];
  if (first) {
    const avail = await call('check_availability', { sku: first.sku });
    r.push(avail.isError ? { level: 'fail', text: `check_availability failed: ${avail.content?.[0]?.text}` } : { level: 'pass', text: `Agents can check availability (${first.name})` });
    const order = await call('prepare_order', { items: [{ sku: first.sku, quantity: 1 }] });
    const s = order.structuredContent;
    if (order.isError || s?.status !== 'not_ordered' || s?.confirmationRequired !== true) {
      r.push({ level: 'fail', text: 'prepare_order must return a summary for the customer to confirm, without ordering' });
    } else if (s.nextStep?.type === 'contact') {
      r.push({ level: 'warn', text: 'Orders end with "contact the business": set an ordering method so customers can confirm in one step' });
    } else {
      r.push({ level: 'pass', text: `Every order ends with the customer confirming (${s.nextStep.type}: ${s.nextStep.label})` });
    }
  }
  const bad = await call('prepare_order', { items: [] });
  r.push(bad.isError ? { level: 'pass', text: 'Bad requests get a clear error, not an order' } : { level: 'fail', text: 'prepare_order accepted an empty order' });
  return r;
}

/**
 * Runs pay_order end to end against simulated rails (never a real node or
 * facilitator): the customer must be asked first, confirmations can't be
 * forged, requests pay the published payee, one confirmation pays for one
 * order, and a payment can't be reused.
 */
async function paymentChecks(project, toolkitVersion) {
  const problems = paymentProblems(project.payments);
  if (problems.length) return problems.map((text) => ({ level: 'fail', text }));
  const r = [];
  const cfg = project.payments;
  if (cfg.lightning) r.push({ level: cfg.lightning.network === 'mainnet' && cfg.lightning.node !== 'simulated' ? 'warn' : 'info', text: cfg.lightning.node === 'simulated' ? 'Lightning: simulated node, no real money' : `Lightning: ${cfg.lightning.node.type === 'nwc' ? 'a wallet over Nostr Wallet Connect' : 'LND'} on ${cfg.lightning.network}${cfg.lightning.network === 'mainnet' ? '. Real money: this is a prototype' : ''}` });
  if (cfg.usdc) r.push({ level: 'info', text: cfg.usdc.facilitator === 'simulated' ? 'USDC: Base Sepolia terms with simulated settlement, no real money' : 'USDC: Base Sepolia, settled by the configured facilitator' });
  if (cfg.usdt) {
    const method = (cfg.usdt.transferMethod ?? 'permit2') === 'permit2' ? 'Permit2' : 'EIP-3009';
    r.push({ level: 'info', text: `USDT: ${method} terms for a test token on ${EVM_TEST_NETWORKS[cfg.usdt.network]}, ${cfg.usdt.facilitator === 'simulated' ? 'simulated settlement, no real money' : 'settled by the configured facilitator'}` });
  }

  const payments = await createPayments(project, { store: memoryStore(), simulate: true });
  const tool = payOrderTool(project, payments);
  const protocol = createProtocol({ serverInfo: serverInfo(project, toolkitVersion), tools: [...businessTools(project), tool] });
  const item = project.catalogue.items.find((i) => i.price != null && inStockOrUnknown(i));
  if (!item) return [...r, { level: 'warn', text: 'No priced item in stock to test pay_order with' }];
  const args = { items: [{ sku: item.sku, quantity: 1 }] };
  const withElicitation = { [META.protocolVersion]: MODERN_VERSIONS[0], [META.clientCapabilities]: { elicitation: { form: {} } } };
  let id = 1;
  const call = async (extra = {}, meta = withElicitation) => (await protocol.handle({
    jsonrpc: '2.0', id: id++, method: 'tools/call',
    params: { name: 'pay_order', arguments: args, ...extra, _meta: { ...meta, ...extra._meta } },
  })).response.result;

  const listed = (await protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: { _meta: withElicitation } })).response.result.tools.find((t) => t.name === 'pay_order');
  r.push(listed?.annotations?.destructiveHint === true && listed.annotations.readOnlyHint === false
    ? { level: 'pass', text: 'pay_order is marked as spending money (destructiveHint), so agent apps treat it with care' }
    : { level: 'fail', text: 'pay_order must be marked destructiveHint: true' });

  const noUi = await call({}, { [META.protocolVersion]: MODERN_VERSIONS[0], [META.clientCapabilities]: {} });
  r.push(noUi.isError ? { level: 'pass', text: 'Apps that can’t ask the customer get no payment request' } : { level: 'fail', text: 'pay_order offered payment to an app that can’t ask the customer' });

  const first = await call();
  const asked = first.resultType === 'input_required' && first.inputRequests?.confirm?.method === 'elicitation/create' && !first.structuredContent;
  r.push(asked ? { level: 'pass', text: 'pay_order asks the customer to confirm before any payment request' } : { level: 'fail', text: 'pay_order must ask the customer before offering a payment request' });
  if (!asked) return r;

  const declined = await call({ inputResponses: { confirm: { action: 'decline' } }, requestState: first.requestState });
  r.push(declined.structuredContent?.status === 'declined' ? { level: 'pass', text: 'A declined order isn’t placed or paid' } : { level: 'fail', text: 'A declined confirmation must stop the order' });

  const accept = { inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } };
  const forged = await call({ ...accept, requestState: `${first.requestState.slice(0, -4)}AAAA` });
  const otherOrder = (await protocol.handle({
    jsonrpc: '2.0', id: id++, method: 'tools/call',
    params: { name: 'pay_order', arguments: { items: [{ sku: item.sku, quantity: 2 }] }, ...accept, requestState: first.requestState, _meta: withElicitation },
  })).response.result;
  r.push(forged.resultType === 'input_required' && otherOrder.resultType === 'input_required'
    ? { level: 'pass', text: 'A confirmation can’t be forged or reused for a different order' }
    : { level: 'fail', text: 'pay_order accepted a forged or mismatched confirmation' });

  const challenge = await call({ ...accept, requestState: first.requestState });
  const required = challenge.structuredContent;
  if (!challenge.isError || required?.x402Version !== 2) return [...r, { level: 'fail', text: 'A confirmed order should get an x402 payment request' }];
  const payeeKey = (network, asset) => `${network}|${String(asset).toLowerCase()}`;
  const published = new Map(payments.payees.map((p) => [payeeKey(p.network, p.asset), p]));
  let bound = true;
  for (const req of required.accepts) {
    if (published.get(payeeKey(req.network, req.asset))?.payTo.toLowerCase() !== req.payTo.toLowerCase()) bound = false;
    if (isLnbtc(req.network)) {
      const inv = decodeInvoice(req.extra.invoice);
      const expected = mcpRequestHash({ server: payments.server, name: 'pay_order', args });
      if (inv.descriptionHash !== expected || inv.payee !== req.payTo || inv.amountMsat !== BigInt(req.amount)) bound = false;
    }
  }
  const labels = required.accepts.map((a) => (isLnbtc(a.network) ? 'Lightning' : published.get(payeeKey(a.network, a.asset))?.symbol ?? a.asset));
  r.push(bound ? { level: 'pass', text: `Payment requests (${labels.join(', ')}) are bound to the order and pay only the published payee` }
    : { level: 'fail', text: 'A payment request is not bound to the order or pays someone other than the published payee' });

  const secondRequest = await call({ ...accept, requestState: first.requestState });
  r.push(secondRequest.resultType === 'input_required'
    ? { level: 'pass', text: 'One confirmation gets one payment request; another needs the customer again' }
    : { level: 'fail', text: 'One confirmation produced a second payment request' });

  const paidWith = (requirement, payload, requestState) => call({
    ...accept, requestState, _meta: { [MCP_PAYMENT_KEY]: { x402Version: 2, resource: required.resource, accepted: requirement, payload } },
  });
  const coinPayload = (requirement) => signEvmPayment({ privateKey: randomPrivateKey(), requirement, now: payments.now() });
  const failText = (res) => res.structuredContent?.error ?? res.content?.[0]?.text;

  const ln = required.accepts.find((a) => isLnbtc(a.network));
  if (ln) {
    const { preimage } = await payments.lightning.node.pay(ln.extra.invoice);
    const done = await paidWith(ln, { preimage }, first.requestState);
    const again = await paidWith(ln, { preimage }, first.requestState);
    r.push(done.structuredContent?.status === 'paid' ? { level: 'pass', text: 'A paid order is recorded for the business (simulated payment)' } : { level: 'fail', text: `A valid payment was not accepted: ${failText(done)}` });
    r.push(again.isError && /duplicate_settlement/.test(again.structuredContent?.error ?? '') ? { level: 'pass', text: 'The same payment can’t be used twice' } : { level: 'fail', text: 'A payment was accepted twice' });
    const coin = required.accepts.find((a) => !isLnbtc(a.network));
    if (coin) {
      const twice = await paidWith(coin, coinPayload(coin), first.requestState);
      r.push(twice.isError && /already been paid/.test(failText(twice) ?? '')
        ? { level: 'pass', text: 'One confirmation pays for one order: a second payment is refused before it settles' }
        : { level: 'fail', text: 'One confirmation paid for two orders' });
    }
  }

  for (const c of payments.coins) {
    const ask = await call();
    const fresh = (await call({ ...accept, requestState: ask.requestState })).structuredContent;
    const requirement = fresh?.accepts?.find((a) => a.network === c.network && a.asset.toLowerCase() === c.token.asset.toLowerCase());
    if (!requirement) {
      r.push({ level: 'fail', text: `The payment request did not offer ${c.symbol}` });
      continue;
    }
    const done = await paidWith(requirement, coinPayload(requirement), ask.requestState);
    const how = transferMethodOf(requirement) === 'permit2' ? ' through Permit2' : '';
    r.push(done.structuredContent?.status === 'paid'
      ? { level: 'pass', text: `A ${c.symbol} payment${how} is checked and recorded (simulated settlement)` }
      : { level: 'fail', text: `A valid ${c.symbol} payment was not accepted: ${failText(done)}` });
  }
  return r;
}

const inStockOrUnknown = (item) => typeof item.stock !== 'number' || item.stock > 0;

function publishChecks(project) {
  const base = baseUrl(project);
  const r = [];
  if (isLocalUrl(base)) {
    r.push({ level: 'warn', text: `Files point to ${base}: fine for testing. Set your real address before publishing (--base-url)` });
  } else {
    r.push(/^https:\/\//.test(base) ? { level: 'pass', text: `Published at ${base}` } : { level: 'fail', text: `${base} should use https://` });
  }
  const mcp = mcpUrl(project);
  if (!isLocalUrl(mcp) && !/^https:\/\//.test(mcp)) r.push({ level: 'fail', text: `MCP endpoint ${mcp} should use https://` });
  return r;
}

export async function checkProject(project, { toolkitVersion, now = new Date() }) {
  let files;
  const results = [
    ...grouped('Business details', businessChecks(project)),
    ...grouped('Catalogue', catalogueChecks(project, now)),
    ...grouped('Safety', safetyChecks(project)),
  ];
  try {
    files = generateOutputs(project, toolkitVersion);
    results.push(...grouped('Generated files', fileChecks(project, files)));
    results.push(...grouped('Agent test', await agentChecks(project, toolkitVersion)));
    if (project.payments) results.push(...grouped('Payments (prototype)', await paymentChecks(project, toolkitVersion)));
  } catch (e) {
    results.push({ group: 'Generated files', level: 'fail', text: `Could not generate files: ${e.message}` });
  }
  results.push(...grouped('Publishing', publishChecks(project)));
  return results;
}

// --- Remote: check a published business by its link ---

async function fetchText(url, fetchImpl, accept) {
  const res = await fetchImpl(url, { headers: { accept }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text(), url: res.url || url };
}

/** Finds the discovery manifest for a link: the link itself, its <link rel="ard">, or the domain's well-known paths. */
async function discover(url, fetchImpl) {
  const tried = [];
  const first = await fetchText(url, fetchImpl, 'application/json, text/html;q=0.9');
  if (first.ok && /json/.test(first.type)) {
    try {
      const doc = JSON.parse(first.text);
      if (Array.isArray(doc.entries)) return { manifest: doc, where: url, page: null };
    } catch { /* fall through */ }
  }
  const page = first.ok && /html/.test(first.type) ? first.text : null;
  if (page) {
    const link = /<link\b[^>]*\brel=["']?(ard|ai-catalog)["']?[^>]*>/i.exec(page);
    const href = link && /\bhref=["']?([^"' >]+)/i.exec(link[0])?.[1];
    if (href) {
      const target = new URL(href, first.url).href;
      tried.push(target);
      const res = await fetchText(target, fetchImpl, 'application/json');
      if (res.ok) return { manifest: JSON.parse(res.text), where: target, page };
    }
  }
  for (const path of ['/.well-known/ard.json', '/.well-known/ai-catalog.json']) {
    const target = new URL(path, url).href;
    tried.push(target);
    const res = await fetchText(target, fetchImpl, 'application/json').catch(() => null);
    if (res?.ok) {
      try {
        return { manifest: JSON.parse(res.text), where: target, page };
      } catch { /* not JSON */ }
    }
  }
  return { manifest: null, tried, page };
}

export async function checkRemote(url, { fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  const add = (group, level, text) => results.push({ group, level, text });

  let found;
  try {
    found = await discover(url, fetchImpl);
  } catch (e) {
    add('Discovery', 'fail', `Could not load ${url}: ${e.message}`);
    return results;
  }
  if (!found.manifest) {
    add('Discovery', 'fail', `No discovery manifest found (tried ${[url, ...(found.tried ?? [])].join(', ')})`);
    return results;
  }
  add('Discovery', 'pass', `Discovery manifest at ${found.where}`);
  if (/ai-catalog\.json$/.test(found.where)) add('Discovery', 'warn', 'Found at the older ai-catalog.json path; ARD v0.91 uses /.well-known/ard.json');
  results.push(...grouped('Discovery', validateArdManifest(found.manifest)));
  if (found.page && /application\/ld\+json/.test(found.page)) add('Discovery', 'pass', 'The page includes schema.org data');

  for (const entry of found.manifest.entries ?? []) {
    if (entry.type === 'application/ai-skill+md' && entry.url) {
      const res = await fetchText(entry.url, fetchImpl, 'text/markdown, text/plain').catch((e) => ({ ok: false, status: e.message }));
      if (res.ok) results.push(...grouped('Agent Skill', validateSkill(res.text)));
      else add('Agent Skill', 'fail', `Could not load ${entry.url} (${res.status})`);
    }
    if (entry.type !== 'application/mcp-server-card+json') continue;
    let card = entry.data;
    if (!card && entry.url) {
      const res = await fetchText(entry.url, fetchImpl, 'application/json').catch((e) => ({ ok: false, status: e.message }));
      if (!res.ok) {
        add('MCP connector', 'fail', `Could not load the server card ${entry.url} (${res.status})`);
        continue;
      }
      card = JSON.parse(res.text);
    }
    results.push(...grouped('MCP connector', validateServerCard(card)));
    for (const remote of (card.remotes ?? []).filter((x) => x.type === 'streamable-http')) {
      results.push(...grouped('MCP connector', await remoteAgentTest(remote.url, fetchImpl)));
    }
  }
  return results;
}

/** Talks to a live MCP endpoint. Only calls tools marked read-only: a check must never order anything. */
async function remoteAgentTest(url, fetchImpl) {
  const r = [];
  const client = new McpHttpClient(url, { fetchImpl });
  try {
    const era = await client.connect();
    r.push({ level: 'pass', text: `${url} answers (MCP ${client.version}${era === 'legacy' ? ', older protocol' : ''})` });
  } catch (e) {
    return [{ level: 'fail', text: `Could not connect to ${url}: ${e.cause?.code ?? e.message}` }];
  }
  let tools = [];
  try {
    tools = (await client.request('tools/list')).tools ?? [];
  } catch (e) {
    return [...r, { level: 'fail', text: `tools/list failed: ${e.message}` }];
  }
  const unlabelled = tools.filter((t) => !t.title && !t.annotations?.title);
  r.push(unlabelled.length
    ? { level: 'warn', text: `Tools without a title: ${unlabelled.map((t) => t.name).join(', ')}` }
    : { level: 'pass', text: `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` });
  const search = tools.find((t) => t.name === 'search_catalogue' && t.annotations?.readOnlyHint === true);
  if (search) {
    try {
      const res = await client.request('tools/call', { name: 'search_catalogue', arguments: {} });
      const count = res.structuredContent?.total;
      r.push(res.isError ? { level: 'fail', text: 'search_catalogue returned an error' } : { level: 'pass', text: `Agents can read the catalogue${count != null ? ` (${count} items)` : ''}` });
    } catch (e) {
      r.push({ level: 'fail', text: `search_catalogue failed: ${e.message}` });
    }
  }
  const risky = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  if (risky.length) r.push({ level: 'info', text: `Not called because they may change things: ${risky.map((t) => t.name).join(', ')}` });
  return r;
}

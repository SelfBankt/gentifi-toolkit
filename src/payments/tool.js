import { createHash, randomBytes } from 'node:crypto';
import { InputRequired, ToolResult } from '../mcp/results.js';
import { ORDER_ARGUMENTS, ToolError, priceOrder } from '../mcp/tools.js';
import { jcs } from './jcs.js';
import { formatSats, formatToken, penceToMsat, penceToTokenUnits } from './quote.js';
import { openState, sealState } from './store.js';
import {
  LNBTC, MCP_PAYMENT_KEY, MCP_PAYMENT_RESPONSE_KEY, checkChallengeInvoice, evmRequirement, isLnbtc, lnbtcRequirement,
  mcpRequestHash, paymentRequired, settleLnbtc, transferMethodOf,
} from './x402.js';

/**
 * pay_order: take payment for an order through the customer's agent.
 *
 * 1. The customer confirms the order in their own app (an MCP elicitation,
 *    sent as an InputRequiredResult). No payment request exists before that.
 * 2. The tool answers with an x402 PaymentRequired: a Lightning invoice bound
 *    to this exact call, and USDC or USDT terms. Payment goes straight to the
 *    business; the toolkit never holds funds.
 * 3. The paid retry is verified (Lightning: the preimage; USDC and USDT: a
 *    facilitator), then the order is recorded for the business.
 *
 * Each confirmation is good for one payment request and one paid order, so an
 * agent can't turn one approval into two payments.
 */

const TOOL = 'pay_order';
const STATE_TTL = 600;
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const joinOr = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items[0] ?? '');
const lower = (v) => String(v ?? '').toLowerCase();

const err = (text, extra = {}) => new ToolResult({ content: [{ type: 'text', text }], isError: true, ...extra });

function x402Error(body) {
  return new ToolResult({ isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] });
}

/** The core fields a paid retry must echo unchanged. */
const coreOf = (r) => ({
  scheme: r.scheme, network: r.network, amount: r.amount, asset: lower(r.asset), payTo: lower(r.payTo),
  maxTimeoutSeconds: r.maxTimeoutSeconds, method: transferMethodOf(r),
});

export function payOrderTool(project, payments) {
  const b = project.business;
  const currency = b.currency || 'GBP';
  const { lightning, coins = [], rates, store, secret, server, now } = payments;
  // USDC and USDT only run on test networks in this prototype
  const testOnly = !lightning || lightning.simulated || lightning.network === LNBTC.testnet.network;
  const rails = joinOr([...(lightning ? ['Lightning'] : []), ...coins.map((c) => c.symbol)]);

  function confirmRequest(order, args) {
    const when = args.collection_date ? ` Collection: ${args.collection_date}.` : '';
    return {
      confirm: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: `Pay ${order.total.formatted} to ${b.name} for ${order.lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')}?${when} `
            + `You'll pay by ${rails}, straight to ${b.name}.${testOnly ? ' Test payment: no real money.' : ''}`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', title: 'Place and pay for this order', description: `Order from ${b.name}, total ${order.total.formatted}`, default: false },
            },
            required: ['confirm'],
          },
        },
      },
    };
  }

  function quote(order) {
    return {
      msat: lightning ? penceToMsat(order.totalMinor, rates.BTC) : null,
      units: Object.fromEntries(coins.map((c) => [c.rail, penceToTokenUnits(order.totalMinor, rates.USD, c.token.decimals)])),
    };
  }

  const amounts = (q) => joinOr([
    ...(q.msat != null ? [formatSats(q.msat)] : []),
    ...coins.map((c) => formatToken(q.units[c.rail], c.symbol, c.token.decimals)),
  ]);

  const resource = (order, q) => ({
    url: `mcp://tool/${TOOL}`,
    description: `${order.summary} At ${b.name}. ${amounts(q)} at today's rates.`,
    mimeType: 'application/json',
    serviceName: b.name.slice(0, 32),
  });

  const coinRequirement = (c, q) => evmRequirement({ token: c.token, network: c.network, amount: q.units[c.rail], payTo: c.payTo, maxTimeoutSeconds: c.maxTimeoutSeconds });

  async function challenge(order, q, requestHash) {
    const accepts = [];
    const notes = [];
    if (lightning) {
      try {
        const { invoice } = await lightning.node.createInvoice({ amountMsat: q.msat, descriptionHash: requestHash, expiry: lightning.maxTimeoutSeconds });
        checkChallengeInvoice(invoice, { network: lightning.network, amountMsat: q.msat, payTo: lightning.payTo, requestHash, maxTimeoutSeconds: lightning.maxTimeoutSeconds, now: now() });
        accepts.push(lnbtcRequirement({ network: lightning.network, amountMsat: q.msat, payTo: lightning.payTo, invoice, requestHash, server, maxTimeoutSeconds: lightning.maxTimeoutSeconds }));
      } catch (e) {
        notes.push(`Lightning is unavailable right now (${e.message}).`);
      }
    }
    for (const c of coins) accepts.push(coinRequirement(c, q));
    if (!accepts.length) return err(`${b.name} can't take a payment right now. ${notes.join(' ')} Use prepare_order for their own checkout or reservation link.`);
    return x402Error(paymentRequired({ resource: resource(order, q), accepts }));
  }

  async function record(order, args, payment, status = 'paid') {
    const entry = {
      id: `ord_${randomBytes(9).toString('base64url')}`,
      createdAt: new Date(now() * 1000).toISOString(),
      business: b.name,
      lines: order.lines.map(({ sku, name, quantity, lineTotalText }) => ({ sku, name, quantity, lineTotal: lineTotalText })),
      total: order.total,
      collectionDate: args.collection_date || undefined,
      note: args.note || undefined,
      payment,
      status,
    };
    await store.addOrder(entry);
    if (payments.orderWebhook) {
      fetch(payments.orderWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry), signal: AbortSignal.timeout(10000) }).catch(() => {});
    }
    return entry;
  }

  function paid(entry, settlement) {
    const p = entry.payment;
    const how = p.rail === 'lightning' ? `${formatSats(p.amount)} by Lightning` : formatToken(p.amount, p.symbol, p.decimals);
    const simulated = p.simulated ? ' (simulated test payment: no money moved)' : '';
    return new ToolResult({
      content: [{ type: 'text', text: `Paid ${how}${simulated}. Order ${entry.id} is with ${b.name}: ${entry.lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')}, total ${entry.total.formatted}.` }],
      structuredContent: { status: 'paid', orderId: entry.id, business: b.name, lines: entry.lines, total: entry.total, collectionDate: entry.collectionDate, payment: p },
      _meta: { [MCP_PAYMENT_RESPONSE_KEY]: settlement },
    });
  }

  return {
    name: TOOL,
    title: `Pay ${b.name} for an order`,
    description: `Place and pay for an order at ${b.name} by ${rails}. The customer confirms the order in their own app before any payment request is made, and payment goes straight to ${b.name}.`
      + (testOnly ? ' Test networks only: no real money.' : ''),
    inputSchema: ORDER_ARGUMENTS,
    annotations: {
      title: `Pay ${b.name} for an order`,
      // Spends the customer's money, so clients should treat it with the most care.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx = {}) {
      if (ctx.era !== 'modern') {
        return err(`Paying through the agent needs an app that supports MCP 2026-07-28, so the customer can confirm in their own app. Use prepare_order for ${b.name}'s own checkout or reservation link instead.`);
      }
      const order = priceOrder(project.catalogue.items, args.items, currency);
      if (!order.priced) return err(`This order includes items priced on request, so it can't be paid here. ${order.warnings.join(' ')} Use prepare_order instead.`);
      if (order.short.length) return err(`Not enough stock: ${order.warnings.join(' ')} Nothing was ordered or paid.`);
      if (!ctx.clientCapabilities?.elicitation) {
        return err('Paying needs an app that can ask the customer to confirm (MCP elicitation). Nothing was ordered or paid. Use prepare_order instead.');
      }

      // 1. The customer's confirmation, tied to this exact order by signed request state
      const digest = sha256hex(jcs({ name: TOOL, arguments: args }));
      const answer = ctx.inputResponses?.confirm;
      if (answer && answer.action && answer.action !== 'accept') {
        return new ToolResult({
          content: [{ type: 'text', text: 'The customer declined. Nothing was ordered or paid.' }],
          structuredContent: { status: 'declined', business: b.name },
        });
      }
      const state = openState(secret, ctx.requestState);
      const confirmed = answer?.action === 'accept' && answer.content?.confirm === true
        && state?.op === TOOL && state.digest === digest && state.exp >= now() && typeof state.id === 'string';
      const askCustomer = () => new InputRequired({
        inputRequests: confirmRequest(order, args),
        requestState: sealState(secret, { op: TOOL, digest, exp: now() + STATE_TTL, id: randomBytes(9).toString('base64url') }),
      });
      if (!confirmed) return askCustomer();

      // 2. Payment terms for this exact call: one payment request per confirmation
      const q = quote(order);
      const requestHash = mcpRequestHash({ server, name: TOOL, args });
      const payment = ctx.meta?.[MCP_PAYMENT_KEY];
      if (!payment) {
        if (!(await store.claim(`confirmation:${state.id}:request`))) return askCustomer();
        return challenge(order, q, requestHash);
      }

      // 3. Verify the payment, then record the order: one paid order per confirmation
      const orderClaim = `confirmation:${state.id}:order`;
      const accepted = payment.accepted ?? {};
      if (lightning && isLnbtc(accepted.network)) {
        const requirements = lnbtcRequirement({
          network: lightning.network, amountMsat: q.msat, payTo: lightning.payTo,
          invoice: accepted.extra?.invoice ?? '', requestHash, server, maxTimeoutSeconds: lightning.maxTimeoutSeconds,
        });
        const settlement = await settleLnbtc({ requirements, payload: payment, now: now(), claim: store.claim });
        if (!settlement.success) {
          return x402Error(paymentRequired({ resource: resource(order, q), accepts: [requirements], error: `Payment not accepted: ${settlement.errorReason}` }));
        }
        const lnPayment = { rail: 'lightning', network: lightning.network, asset: 'BTC', amount: String(q.msat), transaction: settlement.transaction, simulated: lightning.simulated };
        // The money has already moved, so a second payment for one confirmation is recorded for a refund
        if (!(await store.claim(orderClaim))) {
          const entry = await record(order, args, lnPayment, 'duplicate_payment');
          return err(`This confirmed order had already been paid. This Lightning payment still reached ${b.name}, which should refund it (reference ${entry.id}).`, { _meta: { [MCP_PAYMENT_RESPONSE_KEY]: settlement } });
        }
        return paid(await record(order, args, lnPayment), settlement);
      }
      const coin = coins.find((c) => accepted.network === c.network && lower(accepted.asset) === lower(c.token.asset));
      if (coin) {
        const requirements = coinRequirement(coin, q);
        if (jcs(coreOf(accepted)) !== jcs(coreOf(requirements))) {
          return x402Error(paymentRequired({ resource: resource(order, q), accepts: [requirements], error: 'Payment not accepted: the payment terms have changed' }));
        }
        const verified = await coin.facilitator.verify(payment, requirements);
        if (!verified.isValid) {
          return x402Error(paymentRequired({ resource: resource(order, q), accepts: [requirements], error: `Payment not accepted: ${verified.invalidReason}` }));
        }
        // Nothing has moved yet, so a second payment for one confirmation is refused before settling
        if (!(await store.claim(orderClaim))) {
          return err('This confirmed order has already been paid, so nothing more was taken. To place another order, ask the customer to confirm it.');
        }
        const settlement = await coin.facilitator.settle(payment, requirements);
        const coinPayment = {
          rail: coin.rail, network: coin.network, asset: coin.token.asset, symbol: coin.symbol, decimals: coin.token.decimals,
          amount: String(q.units[coin.rail]), transaction: settlement.transaction, payer: settlement.payer ?? verified.payer, simulated: coin.simulated,
        };
        if (settlement.errorReason === 'settlement_pending') {
          const entry = await record(order, args, coinPayment, 'settlement_pending');
          return err(`The payment was sent but hasn't confirmed yet (transaction ${settlement.transaction}). Don't pay again: ${b.name} will check it (reference ${entry.id}).`);
        }
        if (!settlement.success) return err(`Settlement failed (${settlement.errorReason}), so nothing was taken. Ask the customer to confirm again to retry.`);
        return paid(await record(order, args, coinPayment), settlement);
      }
      throw new ToolError(`${b.name} doesn't accept that payment (${accepted.asset ?? 'unknown asset'} on ${accepted.network ?? 'unknown network'}).`);
    },
  };
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeXml as e } from './badge.js';

/**
 * The customer's confirmation, and the witness record it leaves.
 *
 * prepare_order stays read-only: on a Gentifi host it returns a signed link
 * (/o/<token>) that carries the order itself, so nothing is stored when an AI
 * prepares one. Opening the link only shows the order, at today's prices; link
 * previews and crawlers can open it safely. Tapping Confirm (a POST) appends
 * one line to <dir>/<slug>/witness.jsonl: what was agreed, at what price and
 * when. It holds nothing about who the customer is. The page then hands them
 * to the business's own email, checkout, booking page or phone, as before.
 */

export const LINK_DAYS = 7;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** The host's signing key: GENTIFI_ORDER_SECRET, else <dir>/.order-secret, made on first use. */
export async function orderSecret(dir, env = process.env) {
  if (env.GENTIFI_ORDER_SECRET) return env.GENTIFI_ORDER_SECRET;
  const file = join(dir, '.order-secret');
  const saved = await readFile(file, 'utf8').then((s) => s.trim(), () => '');
  if (saved) return saved;
  const made = randomBytes(32).toString('hex');
  await writeFile(file, `${made}\n`, { flag: 'wx' }).catch(() => {});
  await chmod(file, 0o600).catch(() => {});
  return (await readFile(file, 'utf8')).trim();
}

const sign = (secret, body) => b64(createHmac('sha256', secret).update(body).digest().subarray(0, 18));

/**
 * order = { business, items: [[sku, quantity]], collectionDate?, note?, pricesAsOf, preparedAt }
 * Short keys keep the link short enough for any chat app.
 */
export function orderToken(secret, order) {
  const body = b64(JSON.stringify({ b: order.business, i: order.items, c: order.collectionDate || undefined, n: order.note || undefined, p: order.pricesAsOf, t: order.preparedAt }));
  return `${body}.${sign(secret, body)}`;
}

/** The order in a link, or null if it was altered, damaged or is too old. */
export function readOrderToken(secret, token, now = new Date()) {
  const [body, mac, extra] = String(token).split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let o;
  try {
    o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const prepared = new Date(o.t);
  if (Number.isNaN(prepared.getTime()) || now - prepared > LINK_DAYS * 864e5) return null;
  if (!Array.isArray(o.i) || !o.i.length) return null;
  return {
    business: o.b,
    items: o.i.map(([sku, quantity]) => ({ sku: String(sku), quantity: Number(quantity) })),
    collectionDate: o.c ?? '',
    note: o.n ?? '',
    pricesAsOf: o.p ?? '',
    preparedAt: o.t,
  };
}

/** A short reference both the customer and the business can quote: the same link always gives the same one. */
export const orderRef = (token) => createHash('sha256').update(token).digest('hex').slice(0, 8).toUpperCase();

/** The witness record for a confirmation, if this link was confirmed before. */
export async function findWitness(dir, slug, ref) {
  const text = await readFile(join(dir, slug, 'witness.jsonl'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const w = JSON.parse(line);
      if (w.ref === ref) return w;
    } catch { /* a damaged line never hides the others */ }
  }
  return null;
}

/** Appends what the customer agreed to. The note is kept only as a hash: it may hold personal details. */
export async function recordWitness(dir, slug, { ref, order, priced, currency, confirmedAt = new Date() }) {
  const record = {
    ref,
    confirmedAt: confirmedAt.toISOString(),
    preparedAt: order.preparedAt,
    pricesAsOf: order.pricesAsOf,
    lines: priced.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice ?? null, lineTotal: l.lineTotal ?? null })),
    total: priced.total?.amount ?? null,
    currency,
    collectionDate: order.collectionDate || null,
    noteSha256: order.note ? createHash('sha256').update(order.note).digest('hex') : null,
  };
  await appendFile(join(dir, slug, 'witness.jsonl'), `${JSON.stringify(record)}\n`);
  return record;
}

const STYLE = `
  :root { --teal: #05414D; --line: #1C5D69; --copper: #F09A5C; --grey: #E9EDF2; --muted: #B8C4D3; --ink-muted: #3D4A5C; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Sora, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--teal); background: #fff; line-height: 1.55; }
  .shell { max-width: 560px; margin: 0 auto; padding: 0 16px; }
  header { background: var(--teal); color: #fff; padding: 28px 0 32px; }
  .eyebrow { color: var(--copper); font-size: .9rem; margin: 0 0 6px; }
  h1 { font-size: clamp(1.5rem, 6.5vw, 2rem); line-height: 1.2; margin: 0 0 10px; }
  .lede { color: var(--muted); margin: 0; }
  main { padding: 24px 0 40px; }
  table { width: 100%; border-collapse: collapse; font-size: .95rem; }
  th, td { text-align: left; padding: 10px 4px; border-bottom: 1px solid var(--grey); vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-bottom: 0; }
  .meta { margin: 16px 0 0; padding: 0; list-style: none; color: var(--ink-muted); font-size: .9rem; }
  .notice { background: var(--grey); border-radius: 12px; padding: 12px 14px; margin: 16px 0 0; font-size: .92rem; }
  form { margin: 24px 0 0; }
  .btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; border: 0; border-radius: 999px; background: var(--copper); color: var(--teal); font: inherit; font-weight: 700; font-size: 1.05rem; text-decoration: none; cursor: pointer; }
  .small { font-size: .85rem; color: var(--ink-muted); margin: 12px 0 0; }
  .ref { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 600; }
  footer { background: var(--teal); color: var(--muted); padding: 20px 0 28px; font-size: .85rem; }
  footer a { color: #fff; }
  :focus-visible { outline: 3px solid var(--copper); outline-offset: 2px; }
`;

function shell(title, header, body) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="shell">${header}</div></header>
<main><div class="shell">${body}</div></main>
<footer><div class="shell">Gentifi keeps a record of what you confirmed, not who you are. <a href="https://gentifi.com/privacy#connector">Privacy</a></div></footer>
</body>
</html>
`;
}

function orderTable(priced) {
  const rows = priced.lines.map((l) => `<tr><td>${e(l.name)}</td><td class="num">${l.quantity}</td><td class="num">${e(l.lineTotalText ?? l.priceText)}</td></tr>`).join('');
  const total = priced.total ? `<tfoot><tr><td colspan="2">Total</td><td class="num">${e(priced.total.formatted)}</td></tr></tfoot>` : '';
  return `<table><thead><tr><th scope="col">Item</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Price</th></tr></thead><tbody>${rows}</tbody>${total}</table>`;
}

function meta(order, project) {
  const bits = [
    order.collectionDate && `<li>When: ${e(order.collectionDate)}</li>`,
    order.note && `<li>Note: ${e(order.note)}</li>`,
    `<li>Prices from ${e(project.business.name)}’s catalogue, updated ${e(String(project.catalogue.updatedAt).slice(0, 10))}</li>`,
  ].filter(Boolean);
  return `<ul class="meta">${bits.join('')}</ul>`;
}

/** The page the link opens: the order at today's prices, and one Confirm button. */
export function confirmPage({ project, order, priced, changed }) {
  const name = project.business.name;
  const warnings = [
    changed && `${name} has updated its catalogue since your AI prepared this. This is the order at today’s prices.`,
    ...priced.warnings,
  ].filter(Boolean);
  return shell(`Confirm your order with ${name}`,
    `<p class="eyebrow">Check before you confirm</p><h1>Your order with ${e(name)}</h1><p class="lede">Your AI prepared this. Nothing has been ordered yet.</p>`,
    `${orderTable(priced)}${meta(order, project)}
    ${warnings.map((w) => `<p class="notice">${e(w)}</p>`).join('')}
    <form method="post"><button class="btn" type="submit">Confirm</button></form>
    <p class="small">Confirming records what you agreed to. Next you send it to ${e(name)} or finish on their own checkout; they confirm it with you. Not right? Close this page and ask your AI to change it.</p>`);
}

/** After Confirm: the reference, and the business's own way to finish. */
export function confirmedPage({ project, priced, ref, handoff, confirmedAt }) {
  const name = project.business.name;
  const button = handoff.url ? `<p><a class="btn" href="${e(handoff.url)}">${e(handoff.label)}</a></p>` : '';
  return shell(`Confirmed: your order with ${name}`,
    `<p class="eyebrow">&#10003; Confirmed</p><h1>One more step: ${e(handoff.label.charAt(0).toLowerCase() + handoff.label.slice(1))}</h1><p class="lede">Reference <span class="ref">${e(ref)}</span>, confirmed ${e(confirmedAt.slice(0, 16).replace('T', ' '))} UTC.</p>`,
    `${orderTable(priced)}
    <div style="margin-top:24px">${button}</div>
    <p class="small">${e(handoff.customerText)}</p>`);
}

/** Expired, altered or unknown links. */
export function linkProblemPage(message) {
  return shell('Order link', '<p class="eyebrow">Order link</p><h1>This link can’t be used</h1>', `<p>${e(message)}</p><p class="small">Ask your AI to prepare the order again; it will give you a new link.</p>`);
}

import { readFile } from 'node:fs/promises';

/**
 * The owner bot: gentifi-profile's Telegram relay, running on the same machine
 * (github.com/SelfBankt/gentifi-profile, src/gentifi_profile/relay/handoff.py).
 *
 * When a business's owner answers orders in Telegram, a confirmed order goes to
 * the bot instead of the business's email, and the confirmation page shows the
 * customer the owner's answer. Set GENTIFI_BOT_URL (such as http://127.0.0.1:8765)
 * and GENTIFI_BOT_SECRET_FILE (the bot's handoff-secret) to turn it on.
 *
 * Every call answers null when the bot is off, unreachable, slow or refuses:
 * the page then hands the customer to the business as it always has.
 */
export function createBot({ env = process.env, fetchImpl = globalThis.fetch, log = () => {}, timeoutMs = 3000 } = {}) {
  const base = (env.GENTIFI_BOT_URL ?? '').replace(/\/+$/, '');
  const secretFile = env.GENTIFI_BOT_SECRET_FILE ?? '';
  if (!base || !secretFile) return null;
  let secret = null;

  async function call(method, path, body) {
    try {
      // The bot makes its secret on first start, so read it when first needed
      secret ??= (await readFile(secretFile, 'utf8')).trim() || null;
      if (!secret) return null;
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401) secret = null; // re-read it next time, in case it was remade
      if (!res.ok) {
        if (![404, 409].includes(res.status)) log(`Owner bot: ${method} ${path} answered ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      log(`Owner bot unreachable: ${e.message}`);
      return null;
    }
  }

  return {
    /** Does this business's owner answer orders in Telegram right now? */
    async onTelegram(businessId) {
      return (await call('GET', `/handoff/businesses/${encodeURIComponent(businessId)}`))?.telegram === true;
    },
    /** Send a confirmed order; the bot's state for it, or null to fall back to the usual hand-off. */
    async send(order) {
      const state = await call('POST', '/handoff/orders', order);
      // A refused order never reached the owner: only a live state counts as sent
      return state?.status && state.status !== 'failed' ? state : null;
    },
    /** Where an order sent earlier has got to: pending_confirmation, confirmed, declined, expired... */
    status(businessId, ref) {
      return call('GET', `/handoff/orders/${encodeURIComponent(businessId)}/${encodeURIComponent(ref)}`);
    },
  };
}

/**
 * Prices stay in pounds. A payment quote converts the order total at the
 * business's configured rates, rounding up so the business is never short.
 */

/** "79123.45" -> { num: 7912345n, den: 100n } */
export function parseRate(text, label) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`payments.rates.${label} must be a positive number written as text, such as "80000"`);
  const decimals = m[2] ?? '';
  const num = BigInt(m[1] + decimals);
  const den = 10n ** BigInt(decimals.length);
  if (num === 0n) throw new Error(`payments.rates.${label} must be more than zero`);
  return { num, den };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Pence to millisatoshis, given pounds per bitcoin. */
export function penceToMsat(pence, gbpPerBtc) {
  const { num, den } = parseRate(gbpPerBtc, 'BTC');
  // msat = pence / 100 / (num / den) * 1e11
  return ceilDiv(BigInt(pence) * den * 1000000000n, num);
}

/** Pence to a dollar token's atomic units, given dollars per pound. USDC and USDT use 6 decimals. */
export function penceToTokenUnits(pence, usdPerGbp, decimals = 6) {
  const { num, den } = parseRate(usdPerGbp, 'USD');
  // units = pence / 100 * (num / den) * 10^decimals
  return ceilDiv(BigInt(pence) * num * 10n ** BigInt(decimals), 100n * den);
}

export const penceToUsdcUnits = (pence, usdPerGbp) => penceToTokenUnits(pence, usdPerGbp, 6);

export function formatSats(msat) {
  const sats = Number(BigInt(msat) / 1000n);
  return `${sats.toLocaleString('en-GB')} sats`;
}

/** (8128000, 'USDT') -> "8.128 USDT"; always at least two decimals. */
export function formatToken(units, symbol, decimals = 6) {
  const v = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const frac = String(v % scale).padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${v / scale}.${frac} ${symbol}`;
}

export const formatUsdc = (units) => formatToken(units, 'USDC', 6);

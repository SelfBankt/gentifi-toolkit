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

/** Pence to USDC atomic units (6 decimals), given dollars per pound. */
export function penceToUsdcUnits(pence, usdPerGbp) {
  const { num, den } = parseRate(usdPerGbp, 'USD');
  // units = pence / 100 * (num / den) * 1e6
  return ceilDiv(BigInt(pence) * num * 10000n, den);
}

export function formatSats(msat) {
  const sats = Number(BigInt(msat) / 1000n);
  return `${sats.toLocaleString('en-GB')} sats`;
}

/** 8128000 -> "8.128 USDC"; always at least two decimals. */
export function formatUsdc(units) {
  const v = BigInt(units);
  const frac = String(v % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${v / 1000000n}.${frac} USDC`;
}

/**
 * JSON Canonicalization Scheme (RFC 8785) for plain JSON values: members sorted
 * by UTF-16 code units, no whitespace, ECMAScript number and string encoding.
 */

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS cannot encode non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new TypeError('JCS cannot encode invalid Unicode');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    for (const k of keys) if (LONE_SURROGATE.test(k)) throw new TypeError('JCS cannot encode invalid Unicode');
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`JCS cannot encode ${typeof value}`);
}

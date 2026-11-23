// Canonical JSON for MoMo's trust layer (#2139): object keys sorted at every level, undefined left out and strings in NFC, so one action hashes the same however its arguments were written; a value JSON can't hold exactly (NaN, a function, a Date, a cycle) is refused instead of being written as something else.
const MAX_DEPTH = 64;

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function normalize(value, depth) {
  if (depth > MAX_DEPTH) throw new TypeError('nested too deeply to be written as JSON');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    // JSON writes NaN and Infinity as null, which would make two different calls look the same
    if (!Number.isFinite(value)) throw new TypeError('a number JSON cannot hold');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v, depth + 1)));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('only plain objects can be written as JSON');
    const out = Object.create(null);
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .map((k) => [k.normalize('NFC'), k])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [nfc, k] of keys) {
      // two keys that differ only in their Unicode form would otherwise become one
      if (nfc in out) throw new TypeError('two keys with the same text');
      out[nfc] = normalize(record[k], depth + 1);
    }
    return out;
  }
  throw new TypeError(`a ${typeof value} cannot be written as JSON`);
}

/** The canonical JSON text of `value`; throws a TypeError for a value JSON can't hold exactly. */
function canonical(/** @type {unknown} */ value) {
  if (value === undefined) throw new TypeError('undefined cannot be written as JSON');
  return JSON.stringify(normalize(value, 0));
}

module.exports = { canonical };

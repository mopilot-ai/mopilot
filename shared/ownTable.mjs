// Copy a lookup table into an own-key namespace so Object.prototype names take its normal fallback.
/** @template {Readonly<Record<string, unknown>>} T @param {T} values @returns {T} */
export function ownTable(values) {
  return Object.assign(Object.create(null), values);
}

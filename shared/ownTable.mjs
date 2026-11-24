// Copy a lookup table into an own-key namespace so Object.prototype names take its normal fallback.
/** @template {Readonly<Record<string, unknown>>} T @param {T} values @returns {T} */
export function ownTable(values) {
  return Object.assign(Object.create(null), values);
}

/** An own entry of a lookup table that may have crossed a boundary (IPC rebuilds it with Object.prototype): `constructor`, `toString` and `__proto__` are not entries. @template T @param {Readonly<Record<string, T>> | null | undefined} table @param {string} key @returns {T | undefined} */
export function ownGet(table, key) {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

// Read and write opaque keys as own properties while preserving ordinary JSON record prototypes.
/** @template T @param {Record<string, T>} record @param {string} key @returns {T | undefined} */
export function recordValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** @template T @param {Record<string, T>} record @param {string} key @param {T} value */
export function setRecordValue(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

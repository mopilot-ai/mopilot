// Encode string identity tuples without treating separators inside a component as structure.
/** @param {...(string | null)} parts @returns {string} */
export function identityKey(...parts) {
  return JSON.stringify(parts);
}

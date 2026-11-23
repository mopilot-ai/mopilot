// What a Host reports about itself, checked before the app keeps or uses it: the socket path that goes into `ssh -L` and the capability flags that gate tools.

const MAX_SOCKET_PATH = 200;
const MAX_CAPABILITIES = 16;

/**
 * Whether `v` is a path the app may hand to `ssh -L local:<path>`: absolute, bounded, and free of the characters ssh reads as structure (`:` starts a host and port, brackets an IPv6 address) or a terminal reads as control.
 * A macOS Host's path holds a space (`Application Support`), so that stays allowed.
 * @param {unknown} v
 * @returns {v is string}
 */
const validSocketPath = (v) => typeof v === 'string' && v.length <= MAX_SOCKET_PATH && /^\/[^:[\]\\\u0000-\u001f\u007f]+$/.test(v);

/**
 * Whether `v` is a Host's name as it gives it in a challenge (host/src/pairing.mjs): 32 hex digits.
 * @param {unknown} v
 * @returns {v is string}
 */
const validHostKey = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/**
 * The capability flags a Host reported: only plain lowercase names with a boolean, at most 16 of them; anything else is dropped.
 * @param {unknown} v
 * @returns {Record<string, boolean>}
 */
function booleanFlags(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k, x]) => /^[a-z]{1,16}$/.test(k) && typeof x === 'boolean')
      .slice(0, MAX_CAPABILITIES),
  );
}

module.exports = { validSocketPath, validHostKey, booleanFlags };

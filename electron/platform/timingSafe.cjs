// The constant-time text comparison main's pairing and audit checks use, so a secret is never compared byte by byte.
const crypto = require('node:crypto');

/** Whether `given` (any value) is the string `expected`, compared in constant time; never throws on a length mismatch. */
function sameText(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sameText };

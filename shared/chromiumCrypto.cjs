// Chromium's macOS cookie encryption (OSCrypt "v10"), shared by the cookie migration and the browser import: key derivation from a keychain password, and the value format (AES-128-CBC, plus a host hash since cookie schema 24).
const crypto = require('node:crypto');

/** Cookie databases keep a SHA-256 of the cookie's host before the value since this schema version. */
const DOMAIN_HASH_VERSION = 24;
const IV = Buffer.alloc(16, 0x20);

/** Chromium's macOS key: PBKDF2-SHA1 over the keychain password ("saltysalt", 1003 rounds, 16 bytes). */
function deriveKey(password) {
  return crypto.pbkdf2Sync(String(password), 'saltysalt', 1003, 16, 'sha1');
}

/** The cookie's value from an encrypted_value blob ("v10" + AES-128-CBC); null when this key doesn't open it. */
function decryptValue(blob, key, hostKey, dbVersion) {
  const buf = Buffer.from(blob ?? []);
  if (buf.length < 3 + 16 || buf.subarray(0, 3).toString('latin1') !== 'v10') return null;
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, IV);
    plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  } catch {
    return null;
  }
  if (dbVersion >= DOMAIN_HASH_VERSION) {
    const hash = crypto.createHash('sha256').update(String(hostKey)).digest();
    if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) return null;
    plain = plain.subarray(32);
  }
  const value = plain.toString('utf8');
  // without the host hash a wrong key can still pass the padding check; a cookie value is printable text
  if (!Buffer.from(value, 'utf8').equals(plain) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** The inverse of decryptValue (what Chromium writes); tests build old profiles with it. */
function encryptValue(value, key, hostKey, dbVersion) {
  const body = Buffer.from(String(value), 'utf8');
  const plain =
    dbVersion >= DOMAIN_HASH_VERSION ? Buffer.concat([crypto.createHash('sha256').update(String(hostKey)).digest(), body]) : body;
  const c = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
}

module.exports = { DOMAIN_HASH_VERSION, deriveKey, decryptValue, encryptValue };

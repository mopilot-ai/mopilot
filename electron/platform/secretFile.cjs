// Secrets MoPilot keeps on disk (the Claude API key, the MoPilot sign-in, Codex account credentials): one owner-only (0600) file per secret holding {v, enc: 'safe', data}, the value encrypted with Electron safeStorage. Nothing is ever written in plain text: without the OS key a save throws SecretUnavailableError. @host-portable: loads in the Host process without Electron (host/boundary.json).
const fs = require('node:fs');
const { writePrivate } = require('./fsutil.cjs');
const { encryptForStore, canEncrypt } = require('./encryptedStore.cjs');

/** @typedef {{ isEncryptionAvailable(): boolean, encryptString(value: string): Buffer, decryptString(value: Buffer): string }} SafeStorage */

/** A secret could not be encrypted (no OS key), so it was not saved. */
class SecretUnavailableError extends Error {
  constructor(what = 'it') {
    super(`MoPilot can’t encrypt ${what} right now (the system keychain is unavailable), so it wasn’t saved`);
    this.code = 'secret_unavailable';
  }
}

/** The file contents for `text`, encrypted; throws SecretUnavailableError rather than return anything readable. */
function sealSecret(/** @type {SafeStorage | null | undefined} */ safe, /** @type {string} */ text, what = 'it') {
  const sealed = encryptForStore(safe ?? null, text);
  if (!sealed.ok) throw new SecretUnavailableError(what);
  return JSON.stringify({ v: 1, enc: 'safe', data: sealed.value });
}

/** Saves `text` encrypted to `file` (0600, atomic). */
function writeSecret(
  /** @type {string} */ file,
  /** @type {string} */ text,
  /** @type {SafeStorage | null | undefined} */ safe,
  what = 'it',
) {
  writePrivate(file, sealSecret(safe, text, what));
}

/**
 * The secret in `file`: null when there is none (ENOENT). `legacy` marks an envelope an earlier version wrote without
 * encryption ({enc: 'plain'}, base64), which the caller saves again encrypted. Throws when the file is unreadable,
 * malformed or can't be decrypted (another key), so a caller never mistakes it for "no secret" and saves over it.
 * @param {string} file @param {SafeStorage | null | undefined} safe
 * @returns {{ value: string, legacy: boolean } | null}
 */
function readSecret(file, safe) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
  const env = JSON.parse(raw);
  if (typeof env?.data !== 'string') throw new Error('Not a saved secret');
  if (env.enc === 'plain') return { value: Buffer.from(env.data, 'base64').toString('utf8'), legacy: true };
  if (env.enc !== 'safe') throw new Error('Not a saved secret');
  if (!safe) throw new SecretUnavailableError();
  return { value: safe.decryptString(Buffer.from(env.data, 'base64')), legacy: false };
}

module.exports = { SecretUnavailableError, canEncrypt, sealSecret, writeSecret, readSecret };

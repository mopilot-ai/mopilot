// The cloud provider credentials the owner gave the app (Remote Run C1): one per provider, a JSON object (for OCI the identifiers and the signing key) encrypted with safeStorage (login keychain) in a 0600 file; read only to sign a request in this process, never sent to a Host, a log, an argument list or the relay, and shown only as a hint.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { encryptForStore } = require('../platform/encryptedStore.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/** @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

/** @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} o */
function createCloudKeys({ file, safeStorage }) {
  /** @returns {Record<string, string>} */
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isJsonRecord(raw) && isJsonRecord(raw.keys) ? /** @type {Record<string, string>} */ (raw.keys) : {};
    } catch {
      return {};
    }
  };
  /** @param {Record<string, string>} keys */
  const write = (keys) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivate(file, JSON.stringify({ keys }));
  };
  /** The credential of `provider`, decrypted; null when none is kept or it cannot be read. @param {string} provider */
  const get = (provider) => {
    const enc = PROVIDER.test(provider) ? read()[provider] : undefined;
    if (typeof enc !== 'string' || !enc) return null;
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64')));
      return isJsonRecord(value) ? value : null;
    } catch {
      return null;
    }
  };
  return {
    get,
    /** Whether a credential is kept, without decrypting it. @param {string} provider */
    has: (provider) => PROVIDER.test(provider) && typeof read()[provider] === 'string',
    /** Keep `credential` (an object) for `provider`; a refusal never repeats it. @param {unknown} provider @param {unknown} credential */
    set(provider, credential) {
      if (typeof provider !== 'string' || !PROVIDER.test(provider)) throw refusal('That provider is not known.', 'invalid');
      if (!isJsonRecord(credential) || Object.keys(credential).length === 0) throw refusal('That is not a provider key.', 'invalid');
      const encrypted = encryptForStore(safeStorage, JSON.stringify(credential));
      if (!encrypted.ok) throw refusal("This Mac can't encrypt the key, so it was not kept.", 'unavailable');
      write({ ...read(), [provider]: encrypted.value });
    },
    /** @param {unknown} provider */
    remove(provider) {
      const keys = read();
      if (typeof provider !== 'string' || !Object.hasOwn(keys, provider)) return false;
      delete keys[provider];
      write(keys);
      return true;
    },
  };
}

module.exports = { createCloudKeys };

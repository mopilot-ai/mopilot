// The Playwright Extension's connection token, one per Chrome profile, encrypted with safeStorage (its
// key lives in the login keychain). Without a token Chrome asks the user to approve each connection.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { encryptForStore } = require('../../platform/encryptedStore.cjs');
const { readCheckedStore } = require('../../platform/checkedStore.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');

class ChromeTokens {
  /** @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} o */
  constructor(o) {
    this.file = o.file;
    this.safe = o.safeStorage;
  }

  /** Tokens by profile; one that can't be read reads as none, but `forChange` throws rather than write over it. */
  #read(forChange = false) {
    const { data, error } = readCheckedStore(
      this.file,
      'the Chrome connection tokens',
      forChange
        ? (raw) => {
            if (!isJsonRecord(raw) || !isJsonRecord(raw.tokens)) throw new Error('no tokens in it');
            if (Object.hasOwn(raw, 'version')) throw new Error('unsupported version');
            if (!Object.values(raw.tokens).every((token) => typeof token === 'string')) throw new Error('invalid token in it');
            return true;
          }
        : null,
    );
    if (forChange && error) throw new Error(`Couldn't read the saved connection tokens (${error.message}), so they weren't changed`);
    if (forChange) this.saved = isJsonRecord(data) ? data : {};
    return isJsonRecord(data?.tokens) ? data.tokens : {};
  }

  /** The token for a profile ('' is Chrome's last used profile), or null. */
  get(profile = '') {
    const tokens = this.#read();
    if (!Object.hasOwn(tokens, profile || '')) return null;
    const enc = tokens[profile || ''];
    if (typeof enc !== 'string' || !enc) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  has(profile = '') {
    const tokens = this.#read();
    return Object.hasOwn(tokens, profile || '') && typeof tokens[profile || ''] === 'string' && !!tokens[profile || ''];
  }

  /** Stores (or with an empty value removes) a profile's token. False when it can't be stored encrypted. */
  set(profile = '', token) {
    let tokens = { ...this.#read(true) };
    const t = String(token || '').trim();
    if (!t) delete tokens[profile || ''];
    else {
      const encrypted = encryptForStore(this.safe, t);
      if (!encrypted.ok) return false;
      tokens = { ...tokens, [profile || '']: encrypted.value };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify({ ...this.saved, tokens }));
    return true;
  }
}

module.exports = { ChromeTokens };

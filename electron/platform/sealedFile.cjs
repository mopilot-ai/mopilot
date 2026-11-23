// User content MoPilot keeps in one file, encrypted at rest (#2144): the bytes are sealed with AES-256-GCM under a @host-portable: loads in the Host process without Electron (host/boundary.json).
// random data key, and that key is kept with Electron safeStorage in a secret file of its own (secretFile.cjs), so a
// large file (the browser history) costs one fast cipher pass instead of an OS keychain call per write. Files 0600.
// Without the OS key nothing is written; a sealed file that can't be opened throws rather than read as empty.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { writePrivate } = require('./fsutil.cjs');
const { readSecret, writeSecret, canEncrypt } = require('./secretFile.cjs');

/** @typedef {import('./secretFile.cjs').SafeStorage} SafeStorage */

const MAGIC = Buffer.from('MPS1');
const IV = 12;
const TAG = 16;

class SealedFile {
  /**
   * @param {{ file: string, keyFile: string, safeStorage: SafeStorage | null, what: string }} o
   *   what: what the file holds, for the error when it can't be saved (e.g. "the browser history")
   */
  constructor({ file, keyFile, safeStorage, what }) {
    this.file = file;
    this.keyFile = keyFile;
    this.safe = safeStorage;
    this.what = what;
    /** @type {Buffer | null} */
    this.dataKey = null;
  }

  /** Whether it can be saved now (safeStorage has its key). */
  available() {
    return canEncrypt(this.safe);
  }

  /** The data key: the saved one, or (`create`) a new one saved first. Null when there is none and none is made. */
  #key(create = false) {
    if (this.dataKey) return this.dataKey;
    const saved = readSecret(this.keyFile, this.safe);
    if (saved) this.dataKey = Buffer.from(saved.value, 'base64');
    else if (create) {
      const key = crypto.randomBytes(32);
      writeSecret(this.keyFile, key.toString('base64'), this.safe, this.what);
      this.dataKey = key;
    }
    return this.dataKey;
  }

  /** The bytes saved, or null when there is no file. Throws when it is there but can't be opened (another key, damage). */
  read() {
    let sealed;
    try {
      sealed = fs.readFileSync(this.file);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
      throw error;
    }
    if (sealed.length < MAGIC.length + IV + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error(`${this.what} is not a sealed file`);
    const key = this.#key();
    if (!key) throw new Error(`the key of ${this.what} is missing`);
    const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV, sealed.length - TAG)), decipher.final()]);
  }

  /** Saves `bytes` sealed (atomic, 0600); throws SecretUnavailableError without the OS key, writing nothing. */
  write(/** @type {Buffer | Uint8Array} */ bytes) {
    const key = /** @type {Buffer} */ (this.#key(true));
    const iv = crypto.randomBytes(IV);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    // on disk before the caller deletes what it replaces (an earlier version's plain file)
    writePrivate(this.file, Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]), fs, { durable: true });
  }
}

module.exports = { SealedFile };

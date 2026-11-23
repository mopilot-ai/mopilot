// The pairing between MoPilot and its own Chrome extension (design D5, B2 step 2): the shared secret (encrypted with safeStorage), the loopback port, and whether the extension has proved the secret yet.
//
// The pairing code the extension stores is `mopilot-chrome:1:<port>:<secret>`, so the port is part of the
// pairing: a new port (the saved one was taken) or a new secret makes the extension pair again. Without
// safeStorage encryption the secret is kept in memory only, and the extension pairs again after a restart.
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate, readStoreFile } = require('../../platform/fsutil.cjs');
const { canEncrypt } = require('../../platform/encryptedStore.cjs');

/** The port MoPilot tries first, so a pairing usually survives restarts. */
const PREFERRED_PORT = 47615;
/** The longest name this Chrome may be given. */
const NAME_MAX = 80;

/**
 * @typedef {{ secret: string, port: number, paired: boolean, name?: string }} Pairing
 */

class ChromePairing {
  /** @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} o */
  constructor(o) {
    this.file = o.file;
    this.safe = o.safeStorage;
    /** @type {Pairing | null} the pairing when it can't be saved encrypted */
    this.memory = null;
    /** @type {Pairing | null | undefined} the file as last read or written (only this process writes it) */
    this.cached = undefined;
  }

  /** The saved pairing, or null (none yet, or it can't be read or decrypted). */
  get() {
    if (this.memory) return { ...this.memory };
    if (this.cached === undefined) this.cached = this.#load();
    return this.cached ? { ...this.cached } : null;
  }

  /** @returns {Pairing | null} */
  #load() {
    const { data } = readStoreFile(this.file, 'the Chrome extension pairing');
    if (!data || typeof data.secret !== 'string' || !Number.isInteger(data.port)) return null;
    try {
      return {
        secret: this.safe.decryptString(Buffer.from(data.secret, 'base64')),
        port: data.port,
        paired: data.paired === true,
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
      };
    } catch {
      return null;
    }
  }

  /** @param {Pairing} p */
  #save(p) {
    if (!canEncrypt(this.safe)) {
      this.memory = { ...p };
      return p;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(
      this.file,
      JSON.stringify({
        secret: this.safe.encryptString(p.secret).toString('base64'),
        port: p.port,
        paired: p.paired,
        ...(p.name ? { name: p.name } : {}),
      }),
    );
    this.cached = { ...p };
    return p;
  }

  /**
   * The pairing for the port the server listens on: the saved one when it is for this port, else a new secret
   * (the extension has to pair again).
   * @param {number} port
   * @returns {Pairing}
   */
  forPort(port) {
    const p = this.get();
    if (p && p.port === port) return p;
    // a new secret for the new port; the name the user gave this Chrome stays
    return this.#save({ secret: crypto.randomBytes(32).toString('base64url'), port, paired: false, ...(p?.name ? { name: p.name } : {}) });
  }

  /**
   * Names this Chrome (Name this Chrome); returns the name as saved. Throws for a name that isn't 1 to NAME_MAX
   * characters, with no pairing yet, or when it can't be saved (the previous name stays).
   * @param {unknown} name
   */
  rename(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > NAME_MAX) throw new Error(`Use a name of 1 to ${NAME_MAX} characters.`);
    const p = this.get();
    if (!p) throw new Error('Connect this Chrome first.');
    this.#save({ ...p, name: trimmed });
    return trimmed;
  }

  /** The extension proved the secret: the pairing holds. */
  markPaired() {
    const p = this.get();
    if (p && !p.paired) this.#save({ ...p, paired: true });
  }
}

module.exports = { ChromePairing, PREFERRED_PORT, NAME_MAX };

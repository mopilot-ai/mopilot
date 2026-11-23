// The Mac's identity for Mobile Remote: an X25519 key pair (agreement) and an Ed25519 key pair (signing), made on first use and kept only sealed by Electron safeStorage (identity.key, 0600, written whole), the way electron/momo/auditKey.cjs keeps the audit key. Made once even when asked for twice at the same time; a file that can't be opened is an error, never a new identity (that is a re-pair, and only reset() does it).
const { toHex, fromHex } = require('./esm.cjs');
const { readSealedJson, writeSealedJson, RemoteStoreError } = require('./sealedJson.cjs');

/** @typedef {{ macId: string, x: { pk: Uint8Array, sk: Uint8Array }, ed: { pk: Uint8Array, sk: Uint8Array } }} Identity */

class IdentityStore {
  /**
   * @param {{ file: string, safe: import('./sealedJson.cjs').SafeStorage | null, fs: import('./sealedJson.cjs').FsPromises,
   *   prim: import('../../shared/remote/crypto.mjs').Primitives }} o
   */
  constructor(o) {
    this.o = o;
    /** @type {Promise<Identity> | null} */
    this.loading = null;
  }

  /** The identity, made on first use. @returns {Promise<Identity>} */
  get() {
    this.loading ??= this.#load().catch((e) => {
      // a failure is not remembered: encryption may come back, a file may be fixed
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  /** Forgets the identity (a re-pair of every phone follows); the next get() makes a new one. */
  async reset() {
    this.loading = null;
    await this.o.fs.rm(this.o.file, { force: true });
  }

  async #load() {
    const { file, safe, fs, prim } = this.o;
    const read = await readSealedJson({ file, safe, fs });
    if (read.found) {
      const v = read.value;
      const ok = (/** @type {any} */ k) => typeof k?.pk === 'string' && typeof k?.sk === 'string' && /^[0-9a-f]+$/.test(k.pk + k.sk);
      if (v?.v !== 1 || !ok(v.x) || !ok(v.ed)) throw new RemoteStoreError('corrupt', 'The identity file is not what this app writes');
      return this.#shape({ pk: fromHex(v.x.pk), sk: fromHex(v.x.sk) }, { pk: fromHex(v.ed.pk), sk: fromHex(v.ed.sk) });
    }
    const sk = prim.randomBytes(32);
    const x = { pk: prim.x25519Base(sk), sk };
    const ed = prim.edKeypair();
    // on the disk before anyone is told the public keys
    await writeSealedJson({
      file,
      safe,
      fs,
      value: { v: 1, x: { pk: toHex(x.pk), sk: toHex(x.sk) }, ed: { pk: toHex(ed.pk), sk: toHex(ed.sk) } },
    });
    return this.#shape(x, ed);
  }

  #shape(/** @type {Identity['x']} */ x, /** @type {Identity['ed']} */ ed) {
    const id = this.o.prim.sha256(Uint8Array.from([...x.pk, ...ed.pk]));
    return { macId: `mac_${toHex(id).slice(0, 24)}`, x, ed };
  }
}

module.exports = { IdentityStore };

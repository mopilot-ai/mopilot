// MoMo's home key: the one Ed25519 identity the home proves itself with to the user's other Hosts, kept sealed under the home's folder with MoMo's data key so it moves with the home and Reset deletes it. The private half never leaves this module except as signatures.
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../../electron/gateway/sealedFile.cjs');

/** @param {any} v */
const shape = (v) => ({
  publicKey: typeof v?.publicKey === 'string' ? v.publicKey : null,
  privateKey: typeof v?.privateKey === 'string' ? v.privateKey : null,
  // the home this key was made on: a key that arrives on another home came with a move
  madeBy: typeof v?.madeBy === 'string' ? v.madeBy : null,
  // public halves of keys a move retired, for the owner's device to remove from every machine that still has them
  retired: Array.isArray(v?.retired) ? v.retired.filter((/** @type {unknown} */ k) => typeof k === 'string') : [],
});

/** A key's id on a machine's client table: the SHA-256 of its base64 public half. @param {string} publicKey */
export const keyFingerprint = (publicKey) => crypto.createHash('sha256').update(publicKey).digest('hex');

/** @returns {{ publicKey: string, privateKey: string }} */
const made = () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
};

/**
 * @param {{ dir: string, safeStorage: import('../../../electron/platform/secretFile.cjs').SafeStorage, now: () => number, homeId: () => string | null | undefined }} o `dir` the home's storage folder, `safeStorage` MoMo's data key, `homeId` the home this Host is now
 */
export function createHomeKey({ dir, safeStorage, now, homeId }) {
  const file = new SealedJson({ file: path.join(dir, 'home-key.json'), safeStorage, shape, now });
  /** The private key while this home runs; dropped on pause and wipe. @type {import('node:crypto').KeyObject | null} */
  let priv = null;
  /** Made once, on first ask. @returns {Promise<{ publicKey: string, privateKey: string }>} */
  const ensure = () =>
    file.change((/** @type {any} */ all) => {
      if (!all.publicKey || !all.privateKey) {
        Object.assign(all, made(), { madeBy: homeId() ?? null });
      }
      return { publicKey: all.publicKey, privateKey: all.privateKey };
    });
  return {
    /** The public half (base64 SPKI), which the owner's app registers on a machine with `host.clientAdd`. */
    async publicKey() {
      return (await ensure()).publicKey;
    },
    /** The identity `authenticate` (electron/host/pairingClient.cjs) takes: the key and a signer over a Host's challenge. */
    async identity() {
      const keys = await ensure();
      priv ??= crypto.createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
      const key = priv;
      return {
        publicKey: keys.publicKey,
        sign: (/** @type {string} */ purpose, /** @type {string} */ hostId, /** @type {string} */ nonce) =>
          crypto.sign(null, Buffer.from(`${purpose}\n${hostId}\n${nonce}`), key).toString('base64'),
      };
    },
    /**
     * A key that came with a move is not kept: this home makes its own and the old public half is retired, to be removed from every machine that has it. Answers whether it rotated.
     * @returns {Promise<boolean>}
     */
    async rotateIfMoved() {
      const here = homeId();
      const rotated = await file.change((/** @type {any} */ all) => {
        if (!all.publicKey || !all.madeBy || all.madeBy === here) return false;
        all.retired = [...new Set([...all.retired, all.publicKey])];
        Object.assign(all, made(), { madeBy: here ?? null });
        return true;
      });
      if (rotated) priv = null;
      return rotated;
    },
    /** The public halves of the keys a move retired, with the ids the machines know them by. */
    retired: async () => (
      await ensure(), file.read().retired.map((/** @type {string} */ k) => ({ publicKey: k, fingerprint: keyFingerprint(k) }))
    ),
    /** The owner's device removed a retired key from every machine it could reach: this home stops listing it. @param {string} publicKey */
    forgetRetired: (publicKey) =>
      file.change((/** @type {any} */ all) => {
        all.retired = all.retired.filter((/** @type {string} */ k) => k !== publicKey);
      }),
    /** The private key leaves memory (a move begins, Reset). */
    drop() {
      priv = null;
    },
  };
}

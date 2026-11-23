// Dev-only stand-ins for what Electron gives the Mac side: a safeStorage whose key sits in the scratch folder, and the folder itself.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const defaultScratch = () => path.join(homedir(), '.mopilot-mobile-dev-host');

/** The folder, made when missing (mode 700: it holds the sealed identity and the account key). */
export function scratchDir(/** @type {string} */ dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Electron's safeStorage shape over AES-256-GCM with a key file in the scratch folder: it keeps the identity files unreadable
 * to a casual look, nothing more (a real Mac keeps this key in the keychain).
 * @param {string} dir
 */
export function scratchSafeStorage(dir) {
  const file = path.join(dir, 'safe.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  return {
    isEncryptionAvailable: () => true,
    encryptString(/** @type {string} */ text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(/** @type {Buffer} */ sealed) {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

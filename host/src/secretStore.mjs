// The SecretStore port for a headless machine: a 0600 JSON file under the Host's config dir (no safeStorage here; libsecret may follow).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ get: (key: string) => string | null, set: (key: string, value: string) => void, delete: (key: string) => void }} SecretStore
 * @param {string} configDir
 * @returns {SecretStore}
 */
export function createFileSecretStore(configDir) {
  const file = path.join(configDir, 'secrets.json');
  const read = () => {
    try {
      return /** @type {Record<string, string>} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') return {};
      throw e;
    }
  };
  const write = (/** @type {Record<string, string>} */ all) => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    get: (key) => read()[key] ?? null,
    set: (key, value) => write({ ...read(), [key]: value }),
    delete: (key) => {
      const { [key]: _gone, ...rest } = read();
      write(rest);
    },
  };
}

/**
 * The safeStorage the shared secret files (electron/platform/secretFile.cjs) encrypt with, over a key file of this Host: AES-256-GCM,
 * the key in a 0600 file beside the ciphertexts' folder. There is no OS keychain on a headless machine, so this protects a copied
 * secret file, not a reader of the config dir; `status` says secrets are a 0600 file.
 * @param {string} configDir
 */
export function createFileSafeStorage(configDir) {
  const keyFile = path.join(configDir, 'safe-storage.key');
  const readKey = () => {
    try {
      return fs.readFileSync(keyFile);
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const fresh = randomBytes(32);
      // written whole to a file of its own, then linked into place: nobody ever reads half a key, and of two Hosts starting
      // together the first link wins
      const staging = `${keyFile}.${process.pid}.tmp`;
      fs.writeFileSync(staging, fresh, { mode: 0o600 });
      let linked = true;
      try {
        fs.linkSync(staging, keyFile);
      } catch (again) {
        linked = false;
        if (/** @type {any} */ (again).code !== 'EEXIST') {
          fs.rmSync(staging, { force: true });
          throw again;
        }
      }
      fs.rmSync(staging, { force: true });
      return linked ? fresh : fs.readFileSync(keyFile);
    }
  };
  /** @type {Buffer | undefined} */
  let cached;
  const key = () => {
    if (!cached) {
      const found = readKey();
      if (found.length !== 32)
        throw new Error(
          `${keyFile} is damaged (${found.length} bytes, not 32); remove it to start over, which makes the secrets sealed with it unreadable`,
        );
      cached = found;
    }
    return cached;
  };
  return {
    isEncryptionAvailable: () => true,
    /** The key file was replaced (a move brought another key): the next use reads it again. */
    forget() {
      cached = undefined;
    },
    /** @param {string} value */
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(), iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    /** @param {Buffer} sealed */
    decryptString(sealed) {
      const decipher = createDecipheriv('aes-256-gcm', key(), sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

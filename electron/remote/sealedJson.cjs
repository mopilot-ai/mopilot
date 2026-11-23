// One sealed JSON file for Mobile Remote's secrets (identity keys, the device list): Electron safeStorage over the text, written whole through writeDurable (0600, synced, renamed), never plain text; without encryption nothing is written, and a file that can't be opened is reported, never replaced.
const path = require('node:path');
const { encryptForStore } = require('../platform/encryptedStore.cjs');
const { writeDurable } = require('./durableWrite.cjs');

/** The promises API of node:fs, passed in by main (this layer requires no fs): readFile, mkdir, open, rename, rm. @typedef {any} FsPromises */
/** @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage */

/** code: 'unavailable' (no encryption now), 'unreadable' (a file is there that can't be opened), 'corrupt' (opened, not what we write) */
class RemoteStoreError extends Error {
  constructor(/** @type {'unavailable' | 'unreadable' | 'corrupt'} */ code, /** @type {string} */ message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ file: string, safe: SafeStorage | null, fs: FsPromises }} o
 * @returns {Promise<{ found: false } | { found: true, value: any }>}
 */
async function readSealedJson({ file, safe, fs }) {
  let sealed;
  try {
    sealed = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return { found: false };
    throw new RemoteStoreError('unreadable', 'The remote-access file can not be read');
  }
  let text;
  try {
    text = /** @type {SafeStorage} */ (safe).decryptString(Buffer.from(sealed.trim(), 'base64'));
  } catch {
    // another Mac's key, a Keychain reset, or a tampered file: the caller decides, nothing is replaced here
    throw new RemoteStoreError('unreadable', 'The remote-access file can not be opened with this Mac’s key');
  }
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    throw new RemoteStoreError('corrupt', 'The remote-access file is not what this app writes');
  }
}

/** @param {{ file: string, safe: SafeStorage | null, fs: FsPromises, value: unknown }} o */
async function writeSealedJson({ file, safe, fs, value }) {
  const enc = encryptForStore(safe, JSON.stringify(value));
  if (!enc.ok) throw new RemoteStoreError('unavailable', 'Remote access needs encryption, which this Mac can’t offer now');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeDurable(fs, file, `${enc.value}\n`);
}

module.exports = { RemoteStoreError, readSealedJson, writeSealedJson };

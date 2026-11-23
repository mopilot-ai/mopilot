// The key of MoMo's audit log (#2139): 32 random bytes made on first use and kept only sealed by Electron safeStorage (audit.key, 0600, written whole), made again only while there is no log (a key file a crash left empty), never over an existing log; the entries' HMAC and the keyed digest that stands in for an action's arguments.
const crypto = require('node:crypto');
const { canonical } = require('./canonical.cjs');
const { encryptForStore } = require('../platform/encryptedStore.cjs');
const { writeDurable } = require('../gateway/durableWrite.cjs');
const { sameText } = require('../platform/timingSafe.cjs');

/** @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage */

/** code: 'unavailable' (no encryption), 'key' (the key of an existing log is missing or unreadable), 'corrupt' (the log's end can't be continued), 'input' */
class AuditError extends Error {
  constructor(/** @type {string} */ code, /** @type {string} */ message) {
    super(message);
    this.code = code;
  }
}

const unavailableError = () => new AuditError('unavailable', "MoMo's audit log needs encryption, which this Mac can't offer now");

/** The key sealed in `sealed`, or null when it can't be opened (empty, tampered, or sealed with another Mac's key). */
function openKey(/** @type {SafeStorage | null} */ safe, /** @type {string} */ sealed) {
  let hex;
  try {
    hex = /** @type {SafeStorage} */ (safe).decryptString(Buffer.from(sealed.trim(), 'base64'));
  } catch {
    // refused by the caller, or made again when there is no log yet
    return null;
  }
  return typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

/**
 * Reads the sealed key, or makes and seals one when there is no log yet (also over a key file that can't be opened, which a
 * crash or a Keychain reset can leave); never over an existing log, whose entries it would make unverifiable.
 * @param {{ file: string, safe: SafeStorage | null, fs: typeof import('../platform/ports/fs.cjs').fs.promises, hasLog: () => Promise<boolean>, ensureDir: () => Promise<void> }} o
 * @returns {Promise<Buffer>}
 */
async function loadAuditKey({ file, safe, fs, hasLog, ensureDir }) {
  /** @type {string | null} */
  let sealed = null;
  try {
    sealed = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
  }
  const key = sealed === null ? null : openKey(safe, sealed);
  if (key) return key;
  if (await hasLog())
    throw new AuditError(
      'key',
      sealed === null ? "MoMo's audit key is missing, so its log can't be continued or checked" : "MoMo's audit key can't be read",
    );
  const fresh = crypto.randomBytes(32);
  const enc = encryptForStore(safe, fresh.toString('hex'));
  if (!enc.ok) throw unavailableError();
  await ensureDir();
  // on the disk before any entry it signs
  await writeDurable(fs, file, `${enc.value}\n`);
  return fresh;
}

/** The HMAC of an entry without its own `mac`. */
function macOf(/** @type {Buffer} */ key, /** @type {Record<string, unknown>} */ entry) {
  const { mac: _mac, ...rest } = entry;
  return crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
}

/** Whether an entry read back carries the HMAC this key gives it. */
function macMatches(/** @type {Buffer} */ key, /** @type {Record<string, unknown>} */ entry) {
  if (typeof entry.mac !== 'string' || !/^[0-9a-f]{64}$/.test(entry.mac)) return false;
  let want;
  try {
    want = macOf(key, entry);
  } catch {
    // a field JSON can't hold exactly can't have been written by the log
    return false;
  }
  return sameText(entry.mac, want);
}

/** The keyed digest of an action's arguments: the same arguments match, and a guess can't be checked without the key. */
function argsDigest(/** @type {Buffer} */ key, /** @type {unknown} */ args) {
  const sub = crypto.createHmac('sha256', key).update('momo-audit-args-v1').digest();
  return crypto
    .createHmac('sha256', sub)
    .update(canonical(args ?? null))
    .digest('hex');
}

module.exports = { AuditError, unavailableError, loadAuditKey, macOf, macMatches, argsDigest };

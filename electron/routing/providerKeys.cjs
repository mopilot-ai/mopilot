// The model API keys the user gave the app, one per provider slot (shared/llmProviders.mjs keySlotFor; a Host's providers, shared/host/credentials.mjs), encrypted with safeStorage in one 0600 file and shared by Host key lending (electron/host/apiKeys.cjs) and routed chats, so a key is entered once. A key never leaves main except as its last four characters.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { encryptForStore } = require('../platform/encryptedStore.cjs');
const { isJsonRecord, parseJson } = require('../../shared/jsonRecord.mjs');
const { PROVIDERS: HOST_PROVIDERS, isKey, keyHint } = require('../../shared/host/credentials.mjs');
const { LLM_PROVIDERS, checkBaseUrl } = require('../../shared/llmProviders.mjs');

/** The file's name in userData: the Host's key file, kept so keys saved before routing existed stay where they are. */
const KEYS_FILE = 'host-api-keys.json';

/** The slots a key may be kept in by name: every Host provider and every named provider of the catalog. */
const NAMED = new Set([
  ...Object.keys(HOST_PROVIDERS),
  ...Object.values(LLM_PROVIDERS)
    .filter((p) => !p.customBase)
    .map((p) => p.keySlot),
]);
/** The slot prefixes of providers whose endpoint the user names: `<slot>:<origin>`. */
const CUSTOM = new Set(
  Object.values(LLM_PROVIDERS)
    .filter((p) => p.customBase)
    .map((p) => p.keySlot),
);

/** Whether `slot` can hold a key: a named slot, or a custom one for exactly one origin. @param {unknown} slot @returns {slot is string} */
function isSlot(slot) {
  if (typeof slot !== 'string') return false;
  if (NAMED.has(slot)) return true;
  const at = slot.indexOf(':');
  if (at < 0 || !CUSTOM.has(slot.slice(0, at))) return false;
  const base = checkBaseUrl(slot.slice(at + 1));
  return base.ok && base.origin === slot.slice(at + 1);
}

/** A key a user's own server takes may be short (vLLM's `--api-key token-abc`): printable, no spaces, 1 to 512 characters. */
const LOOSE_KEY = /^[\x21-\x7e]{1,512}$/;
/** @param {string} slot @param {string} key */
const keyFits = (slot, key) => (NAMED.has(slot) ? isKey(key) : LOOSE_KEY.test(key));

/** A refusal the window shows as it is; it never repeats the key. @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/** Listeners by resolved file: every store over one file hears every write to it, whichever store made it (Host lending and routing each hold one). */
/** @type {Map<string, Set<(slots: string[]) => void>>} */
const LISTENERS = new Map();

/**
 * @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string, getSelectedStorageBackend?(): string }} SafeStorage
 * @param {{ file: string, safeStorage: SafeStorage }} o
 */
function createProviderKeys({ file, safeStorage }) {
  const at = path.resolve(file);
  /** @type {Set<(slots: string[]) => void>} */
  const listeners = LISTENERS.get(at) ?? new Set();
  LISTENERS.set(at, listeners);
  /**
   * The encrypted keys by slot, and the file's other fields (a newer version's, written back as they were). A missing file, or one
   * with no `keys`, holds none. One that is there but can't be read or parsed is `unreadable` (and `damaged` when it was read but is
   * not a key file): nothing is decrypted from it. The error is not logged: its text can quote the file.
   * @returns {{ keys: Record<string, unknown>, rest: Record<string, unknown>, unreadable: boolean, damaged: boolean }}
   */
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(at, 'utf8');
    } catch (error) {
      return { keys: {}, rest: {}, unreadable: /** @type {any} */ (error)?.code !== 'ENOENT', damaged: false };
    }
    // not JSON, a root that is not a record, or `keys` that are not one: damaged
    const parsed = parseJson(raw);
    if (parsed.ok && isJsonRecord(parsed.value) && (parsed.value.keys === undefined || isJsonRecord(parsed.value.keys))) {
      const { keys = {}, ...rest } = parsed.value;
      return { keys, rest, unreadable: false, damaged: false };
    }
    return { keys: {}, rest: {}, unreadable: true, damaged: true };
  };
  /**
   * The keys as they are now, for a change. A damaged file holds no key that could be read, so a new key may start a fresh file once
   * the damaged one is kept as `<file>.unreadable` (or, when an earlier copy is there, `<file>.unreadable-<uuid>`: no copy is written
   * over). A file that can't be read at all (its permissions, a folder in its place) may hold keys, so the change is refused and the
   * file left as it is, as it is when no copy can be made.
   * @param {boolean} recover
   * @returns {{ keys: Record<string, unknown>, rest: Record<string, unknown> }}
   */
  const current = (recover) => {
    const now = read();
    if (now.damaged && recover) {
      if (!keepCopy(`${at}.unreadable`) && !keepCopy(`${at}.unreadable-${randomUUID()}`))
        throw refusal('The saved API keys can’t be read, so nothing was changed.', 'unreadable');
      return { keys: {}, rest: {} };
    }
    if (now.unreadable && !now.damaged) throw refusal('The saved API keys can’t be read, so nothing was changed.', 'unreadable');
    return now;
  };
  /** Copy the file to `to`, never over anything there; whether it was copied. @param {string} to */
  const keepCopy = (to) => {
    try {
      fs.copyFileSync(at, to, fs.constants.COPYFILE_EXCL);
      return true;
    } catch {
      return false;
    }
  };
  /** @param {{ keys: Record<string, unknown>, rest: Record<string, unknown> }} file @param {string[]} slots the slots this write changed */
  const write = ({ keys, rest }, slots) => {
    fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
    writePrivate(at, JSON.stringify({ ...rest, keys }), fs, { durable: true });
    for (const fn of [...listeners]) fn(slots);
  };
  /** The key in `slot`, decrypted; null when none is kept or it cannot be decrypted (another Mac's file). @param {unknown} slot */
  const get = (slot) => {
    const enc = isSlot(slot) ? read().keys[slot] : undefined;
    if (typeof enc !== 'string' || !enc) return null;
    try {
      const key = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      return keyFits(/** @type {string} */ (slot), key) ? key : null;
    } catch {
      return null;
    }
  };
  /** Forget the keys in `slots` in one write; the ones that were kept. A damaged file holds none to forget. @param {unknown[]} slots @returns {string[]} */
  const removeAll = (slots) => {
    const now = current(false);
    const gone = /** @type {string[]} */ (slots.filter((s) => typeof s === 'string' && Object.hasOwn(now.keys, s)));
    if (!gone.length) return [];
    for (const s of gone) delete now.keys[s];
    write(now, gone);
    return gone;
  };
  return {
    get,
    /** Whether a key is kept in `slot`, without decrypting it. @param {unknown} slot */
    has: (slot) => {
      const enc = isSlot(slot) ? read().keys[slot] : undefined;
      return typeof enc === 'string' && !!enc;
    },
    /** Whether the file can be read; while it can't, every key reads as none (and only a damaged one takes a new key). */
    readable: () => !read().unreadable,
    /**
     * Keep `key` in `slot`, encrypted; returns its last four characters.
     * @param {unknown} slot @param {unknown} key
     */
    set(slot, key) {
      if (!isSlot(slot)) throw refusal('That provider takes no key here.', 'invalid');
      const trimmed = typeof key === 'string' ? key.trim() : '';
      if (!keyFits(slot, trimmed)) throw refusal('That is not an API key.', 'invalid');
      // encrypted first: a key that can't be kept makes no copy of a damaged file
      const encrypted = encryptForStore(safeStorage, trimmed);
      if (!encrypted.ok) throw refusal("This Mac can't encrypt the key, so it was not kept.", 'unavailable');
      const now = current(true);
      write({ rest: now.rest, keys: { ...now.keys, [slot]: encrypted.value } }, [slot]);
      return keyHint(trimmed);
    },
    /** Forget the keys in `slots` in one write; the ones that were kept. @param {unknown[]} slots */
    removeAll,
    /** Forget the key in `slot`; false when none was kept. @param {unknown} slot */
    remove: (slot) => removeAll([slot]).length > 0,
    /** Told after a key is added or removed, by this store or another over the same file, with the slots that changed. @param {(slots: string[]) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createProviderKeys>} ProviderKeys */

module.exports = { createProviderKeys, isSlot, KEYS_FILE };

// Encrypted JSON files (#2139), used by MoMo's stores and the gateway's token vault: one owner-only (0600) file in an owner-only (0700) folder, its value sealed with the injected safeStorage (secretFile.cjs format) and written durably (durableWrite.cjs); without encryption nothing is read or written, never plain text. A damaged file is set aside rather than taken for empty (and the copy deleted after 30 days); one sealed with another key is left alone and refused. Changes take turns: in this process through a queue, across MoPilots through the file's lock (fileLock.cjs), waited for without blocking main. Its error texts still speak of MoMo's data, its only user so far.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canEncrypt, sealSecret } = require('../platform/secretFile.cjs');
const { writeDurable } = require('./durableWrite.cjs');
const { acquireLock, LockError } = require('./fileLock.cjs');

/** @typedef {import('../platform/secretFile.cjs').SafeStorage} SafeStorage */

/** How long a set-aside copy of a damaged file is kept (MoMo keeps nothing longer). */
const ASIDE_KEEP_MS = 30 * 86_400_000;
/** How often a change waiting for another MoPilot's looks again. */
const LOCK_POLL_MS = 10;

const TEXT = {
  unavailable: 'MoMo can’t encrypt its data right now (the system keychain is unavailable)',
  other_key: 'MoMo’s data was encrypted with another key (another build or keychain), so it can’t be read here',
  busy: 'MoMo’s data is being changed by another MoPilot; try again',
  erased: 'MoMo was reset, so that change was dropped',
};

/**
 * MoMo can't use its data now: no encryption, sealed with another key, another MoPilot is changing it, or MoMo was
 * reset after the change was asked for.
 */
class SealedUnavailableError extends Error {
  /** @param {'unavailable' | 'other_key' | 'busy' | 'erased'} code */
  constructor(code = 'unavailable') {
    super(TEXT[code]);
    this.code = code;
  }
}

/** Make `dir` (and its parents) and keep it to the owner alone. */
function privateDir(/** @type {string} */ dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Move a damaged file out of the way (kept for the user for 30 days, never read again); resolves where it went. */
function setAside(/** @type {string} */ file, /** @type {number} */ at) {
  const aside = `${file}.unreadable-${at}-${crypto.randomUUID().slice(0, 8)}`;
  fs.renameSync(file, aside);
  return aside;
}

/** Delete the set-aside copies of `file` older than 30 days. */
async function pruneAside(/** @type {string} */ file, /** @type {number} */ now) {
  const prefix = `${path.basename(file)}.unreadable-`;
  for (const name of await fs.promises.readdir(path.dirname(file))) {
    const at = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    if (name.startsWith(prefix) && now - at >= ASIDE_KEEP_MS) await fs.promises.rm(path.join(path.dirname(file), name), { force: true });
  }
}

/**
 * The value in `file`: `value` null when there is none. A file that isn't a sealed envelope, was written in plain text,
 * or decrypts to something that isn't JSON is renamed aside (`setAside`), so the next write doesn't lose it. One that
 * doesn't decrypt (another key) or can't be read at all throws and stays as it is.
 * @param {string} file @param {SafeStorage | null | undefined} safe @param {number} at
 * @returns {{ value: unknown, setAside: string | null }}
 */
function readSealed(file, safe, at) {
  if (!canEncrypt(safe)) throw new SealedUnavailableError();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return { value: null, setAside: null };
    throw error;
  }
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return { value: null, setAside: setAside(file, at) };
  }
  if (env?.enc !== 'safe' || typeof env.data !== 'string') return { value: null, setAside: setAside(file, at) };
  let text;
  try {
    text = /** @type {SafeStorage} */ (safe).decryptString(Buffer.from(env.data, 'base64'));
  } catch {
    throw new SealedUnavailableError('other_key');
  }
  try {
    return { value: JSON.parse(text), setAside: null };
  } catch {
    return { value: null, setAside: setAside(file, at) };
  }
}

/** Seal `value` into `file` (0600, synced, renamed into place); throws SecretUnavailableError rather than write anything readable. */
function writeSealed(/** @type {string} */ file, /** @type {unknown} */ value, /** @type {SafeStorage | null | undefined} */ safe) {
  return writeDurable(fs.promises, file, sealSecret(safe, JSON.stringify(value), 'MoMo’s data'));
}

/**
 * Run `fn` holding `<file>.lock` (fileLock.cjs: owner pid and start time, a dead owner's lock taken over in one step),
 * so a change from another MoPilot can't interleave with this one. Waits up to `waitMs` for another MoPilot's change,
 * without blocking main, then says busy.
 * @template T @param {string} file @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function withLock(file, fn, { waitMs = 500, now = Date.now, lock = acquireLock } = {}) {
  const deadline = now() + waitMs;
  let held;
  for (;;) {
    try {
      held = await lock({ fs: fs.promises, file: `${file}.lock` });
      break;
    } catch (error) {
      if (!(error instanceof LockError)) throw error;
      if (now() >= deadline) throw new SealedUnavailableError('busy');
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    // release() removes the lock only while it is still this change's
    await held.release();
  }
}

/**
 * One sealed JSON file as a small store: `read()` the value as it is on disk (never cached: another MoPilot may have
 * written it), `change(fn)` reads, changes and writes it back holding the lock, one change at a time in this process,
 * and keeps nothing when the write fails. `shape(value, now)` turns what was read (any shape, null when there is none)
 * into the store's value, and is applied again before each write (retention).
 * @template T
 */
class SealedJson {
  /**
   * @param {{ file: string, safeStorage: SafeStorage | null | undefined, shape: (value: unknown, now: number) => T,
   *   now?: () => number, lockWaitMs?: number, lock?: typeof acquireLock }} o
   */
  constructor({ file, safeStorage, shape, now = Date.now, lockWaitMs = 500, lock = acquireLock }) {
    if (!path.isAbsolute(file)) throw new Error('MoMo’s data needs an absolute folder');
    this.file = file;
    this.safe = safeStorage;
    this.shape = shape;
    this.now = now;
    this.lockWaitMs = lockWaitMs;
    this.lock = lock;
    /** where an unreadable file was set aside, once */
    this.setAside = /** @type {string | null} */ (null);
    /** @type {Promise<unknown>} this process's changes, in order */
    this.queue = Promise.resolve();
    /** bumped by erase(): a change asked for before it never writes */
    this.generation = 0;
  }

  /** @returns {T} */
  read() {
    privateDir(path.dirname(this.file));
    const { value, setAside } = readSealed(this.file, this.safe, this.now());
    if (setAside) this.setAside = setAside;
    return this.shape(value, this.now());
  }

  /** @template R @param {(value: T) => R | Promise<R>} fn @returns {Promise<R>} */
  change(fn) {
    const generation = this.generation;
    const current = () => {
      if (generation !== this.generation) throw new SealedUnavailableError('erased');
    };
    const run = async () => {
      current();
      privateDir(path.dirname(this.file));
      return withLock(
        this.file,
        async () => {
          const next = this.read();
          const before = JSON.stringify(next);
          const out = await fn(next);
          current();
          const kept = this.shape(next, this.now());
          // nothing changed: nothing is written (an erased store isn't made again by a change that found nothing)
          if (JSON.stringify(kept) === before) return out;
          await writeSealed(this.file, kept, this.safe);
          await pruneAside(this.file, this.now());
          return out;
        },
        // the wait is real time, whatever clock the store's records use
        { waitMs: this.lockWaitMs, lock: this.lock },
      );
    };
    const next = this.queue.then(run, run);
    // the queue only keeps changes in order; each caller gets its own result or failure
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Delete the file and its set-aside copies (Reset MoMo), holding the lock. Every change asked for before it is dropped
   * (it rejects as `erased`), so none writes the data back. Needs no encryption: it reads nothing; a folder that was
   * never made has nothing to erase.
   */
  erase() {
    this.generation++;
    const run = async () => {
      if (!fs.existsSync(path.dirname(this.file))) return;
      await withLock(
        this.file,
        async () => {
          await fs.promises.rm(this.file, { force: true });
          await pruneAside(this.file, Number.POSITIVE_INFINITY);
        },
        { waitMs: this.lockWaitMs, lock: this.lock },
      );
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

module.exports = { SealedUnavailableError, SealedJson, privateDir, readSealed, writeSealed, withLock, pruneAside, ASIDE_KEEP_MS };

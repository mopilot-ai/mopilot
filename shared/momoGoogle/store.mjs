// The home's sealed files for the Google connector: the account record and the durable change cursors (a version per thread and event), each one AES-sealed with the Host's safeStorage, 0600 in a 0700 folder, written whole through a temp file.
import path from 'node:path';
export class SealUnavailableError extends Error {
  constructor() {
    super('Google data cannot be sealed on this machine right now');
  }
}
/** One sealed JSON value in a file; changes run one after another. Without encryption nothing is read or written, never plain text. */
class SealedValue {
  #queue = Promise.resolve();
  file;
  safeStorage;
  io;
  constructor(file, safeStorage, io) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.io = io;
  }
  /** The value, or null when there is no file. A file that does not decrypt throws: it is never taken for empty. */
  async read() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new SealUnavailableError();
    let raw;
    try {
      raw = await this.io.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    const envelope = JSON.parse(raw);
    if (envelope?.enc !== 'safe' || typeof envelope.data !== 'string') throw new Error('The Google file is not a sealed envelope');
    return JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.data, 'base64')));
  }
  write(value) {
    return this.#turn(async () => {
      if (!this.safeStorage.isEncryptionAvailable()) throw new SealUnavailableError();
      await this.io.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await this.io.chmod(path.dirname(this.file), 0o700);
      const tmp = `${this.file}.${process.pid}.tmp`;
      // the envelope every sealed MoMo file has ({enc:'safe', data}), which the move's travel check opens too
      const data = this.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
      await this.io.writeFile(tmp, JSON.stringify({ v: 1, enc: 'safe', data }), { mode: 0o600 });
      await this.io.rename(tmp, this.file);
    });
  }
  remove() {
    return this.#turn(() => this.io.rm(this.file, { force: true }));
  }
  async #turn(step) {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await step();
    } finally {
      release();
    }
  }
}
/** Most grants kept owed at once: more than a person ever connects, so the file stays small however often Google cannot be reached. */
export const MAX_OWED = 5;
/**
 * The grants that were disconnected here while Google could not be reached, so their refresh tokens are still live: `<dir>/google-revoke-owed.json`, sealed
 * with the Host's own key (a Reset keeps it, a move does not carry it: the Host that owes the revoke is the one that tries again).
 */
export function createOwedFile(dir, safeStorage, io) {
  const value = new SealedValue(path.join(dir, 'google-revoke-owed.json'), safeStorage, io);
  return {
    /** The tokens owed, oldest first. */
    async load() {
      const v = await value.read();
      return Array.isArray(v?.owed) ? v.owed.filter((o) => typeof o?.token === 'string') : [];
    },
    save: (owed) => (owed.length ? value.write({ owed: owed.slice(-MAX_OWED) }) : value.remove()),
  };
}
/** The account record file: `<dir>/google-account.sealed`. */
export function createAccountFile(dir, safeStorage, io) {
  const value = new SealedValue(path.join(dir, 'google-account.sealed'), safeStorage, io);
  return { load: () => value.read(), save: (a) => value.write(a), clear: () => value.remove() };
}
/** Most cursors kept: the oldest go first, so the file does not grow with every thread ever seen. */
export const MAX_CURSORS = 5000;
/** How long cursor changes are gathered before the file is rewritten once. */
const FLUSH_MS = 500;
/**
 * The durable cursors, read by the notice pipeline's change detection: `<dir>/google-versions.sealed`. A change is in memory at once and
 * written within half a second (a crash in between only means the item is looked at again, which change detection expects); `flush` writes now.
 */
export function createVersionStore(dir, safeStorage, io, { delayMs = FLUSH_MS, max = MAX_CURSORS, report = () => undefined } = {}) {
  const value = new SealedValue(path.join(dir, 'google-versions.sealed'), safeStorage, io);
  let cache = null;
  /** The cursors once read: what a flush writes. */
  let loaded = null;
  let timer = null;
  /** Set by `discard`: a reader that outlives its home (a move, a reset) can no longer write cursors into a folder that is gone. */
  let closed = false;
  const all = () =>
    (cache ??= value
      .read()
      .then((v) => v ?? {})
      .catch((e) => {
        cache = null;
        throw e;
      }));
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (loaded && !closed) await value.write(loaded);
  };
  return {
    get: async (key) => (await all())[key],
    set: async (key, version) => {
      if (closed) return;
      const map = await all();
      loaded = map;
      // the newest last, so the oldest are the ones to go
      delete map[key];
      map[key] = version;
      for (const old of Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - max))) delete map[old];
      timer ??= setTimeout(() => void flush().catch((e) => report(e)), delayMs).unref();
    },
    flush,
    /** Forgets what is in memory without writing it (the file is being deleted or moved). */
    discard: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      cache = null;
      loaded = null;
      closed = true;
    },
    clear: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      cache = Promise.resolve({});
      loaded = null;
      await value.remove();
    },
  };
}
/** The Google OAuth clients this home holds (`{ desktop, ios? }`), sealed like the rest so a move carries them: `<dir>/google-clients.sealed`. */
export function createClientsFile(dir, safeStorage, io) {
  const value = new SealedValue(path.join(dir, 'google-clients.sealed'), safeStorage, io);
  return { load: () => value.read(), save: (c) => value.write(c), clear: () => value.remove() };
}

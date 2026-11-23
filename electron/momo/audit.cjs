// MoMo's audit log (#2139): an append-only, hash-chained JSONL log on this Mac, one per MoPilot data folder (production <userData>/momo/audit, folder 0700, files 0600), held by one owner at a time through a lock file. Each entry carries the HMAC of the one before it and is HMAC'ed with a key kept encrypted by Electron safeStorage; without encryption nothing is written, never an unkeyed log. An intent entry reaches the disk (fsync) before each side-effecting action and an outcome entry (done / not sent / uncertain) after; arguments are kept only as a keyed digest. verify() names the first broken link, and a sealed checkpoint of the last entry shows entries cut from the end (rotation records the last entry of each file it removes); the log rotates by size and exports as JSONL; a line cut short at the end is removed and recorded; after a lost key, startOver() sets the old log aside and starts a new chain. `note` holds only the app's own texts, never an action's output. Chain design after openmuse audit.py (MIT, (c) 2026 tahodev).
const crypto = require('node:crypto');
const { fs: fsPort } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { canonical } = require('./canonical.cjs');
const { AuditError, unavailableError, loadAuditKey, macOf, macMatches, argsDigest } = require('./auditKey.cjs');
const { acquireLock } = require('../gateway/fileLock.cjs');
const { writeDurable } = require('../gateway/durableWrite.cjs');
const { GENESIS, reaches, chainChecker, unfinishedScanner } = require('./auditRead.cjs');
const { encryptForStore, canEncrypt } = require('../platform/encryptedStore.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

const KEY_FILE = 'audit.key';
const LOCK_FILE = 'audit.lock';
/** The last entry's number and HMAC, sealed by safeStorage: entries cut from the end show against it. */
const HEAD_FILE = 'audit.head';
const CURRENT = 'audit.jsonl';
const ROTATED = /^audit\.(\d{6})\.jsonl$/;
const RESULTS = Object.freeze({ DONE: 'done', NOT_SENT: 'not sent', UNCERTAIN: 'uncertain' });
const RESULT_SET = new Set(/** @type {string[]} */ (Object.values(RESULTS)));
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_LABEL = 200;
const MAX_NOTE = 500;

/**
 * @typedef {import('./auditKey.cjs').SafeStorage} SafeStorage
 * @typedef {{ action: string, args?: unknown, chatId: string, harness?: string, account?: string, decision: string, device?: string }} ActionFields
 * @typedef {{ ok: true, entries: number, from: number, last: number }
 *         | { ok: false, entries: number, file: string, line: number, reason: 'unreadable' | 'mac' | 'gap' | 'link' | 'torn' | 'cut' | 'checkpoint' }} Verdict
 *   entries: how many entries checked out before the first broken one; from: the first entry's number (older files may have rotated away)
 */

const notFound = (/** @type {any} */ e) => e?.code === 'ENOENT';

function label(/** @type {unknown} */ v, /** @type {string} */ name, required = false) {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && !v) || v.length > MAX_LABEL) throw new AuditError('input', `${name} must be a short string`);
  return v;
}

class AuditLog {
  /** @type {Promise<unknown>} the end of the write queue */
  #tail = Promise.resolve();
  /** @type {Promise<Buffer> | null} */
  #keyP = null;
  /** @type {{ seq: number, mac: string } | null} the last entry on disk, null until read (or after a failed write) */
  #head = null;
  /** the current file's size after this log's last write: another size means someone else wrote, and the end is read again */
  #headSize = 0;
  #dirReady = false;
  /** @type {Promise<{ release(): Promise<void> }> | null} this log's hold on the folder, for its lifetime */
  #lockP = null;
  /** @type {Map<string, { action: string, chatId: string, harness: string, account: string, device?: string }>} intents of this process without an outcome yet */
  #open = new Map();
  /** @type {Promise<void> | null} a Reset deleting the folder: no key is made until it is gone */
  #erasing = null;

  /**
   * @param {{ dir: string, safeStorage: SafeStorage | null, fs?: typeof fsPort.promises, now?: () => number, newId?: () => string,
   *           maxBytes?: number, maxFiles?: number, lock?: { pid?: number, isAlive?: (pid: number) => boolean } }} o
   *   dir: one per MoPilot data folder (production <userData>/momo/audit), so a dev instance and the installed app
   *   never share a log; maxBytes: the current file's size that starts a new one; maxFiles: how many files are kept, the
   *   oldest removed first; lock: who this log is, for the folder lock (tests)
   */
  constructor({
    dir,
    safeStorage,
    fs = fsPort.promises,
    now = Date.now,
    newId = () => crypto.randomUUID(),
    maxBytes = MAX_BYTES,
    maxFiles = MAX_FILES,
    lock = {},
  }) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error("MoMo's audit log needs an absolute folder");
    this.dir = dir;
    this.safe = safeStorage ?? null;
    this.fs = fs;
    this.now = now;
    this.newId = newId;
    this.maxBytes = maxBytes;
    this.maxFiles = Math.max(1, maxFiles);
    this.lockAs = lock;
  }

  /** Whether this Mac can encrypt the key now; without it nothing is written or checked. */
  available() {
    return canEncrypt(this.safe);
  }

  /** Runs `fn` after everything queued before it; one task's failure does not stop the next. */
  #queue(/** @type {() => Promise<any>} */ fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #path(/** @type {string[]} */ ...names) {
    return path.join(this.dir, ...names);
  }

  async #ensureDir() {
    if (this.#dirReady) return;
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // a folder that existed already keeps its mode otherwise
    await this.fs.chmod(this.dir, 0o700);
    this.#dirReady = true;
  }

  async #currentSize() {
    try {
      return (await this.fs.stat(this.#path(CURRENT))).size;
    } catch (e) {
      if (notFound(e)) return 0;
      throw e;
    }
  }

  /** The log's files, oldest first. */
  async #files() {
    // the folder exists: it is made before the lock is taken
    const names = await this.fs.readdir(this.dir);
    const rotated = names.filter((n) => ROTATED.test(n)).sort();
    return names.includes(CURRENT) ? [...rotated, CURRENT] : rotated;
  }

  /** Holds the folder for this log's lifetime (until close()); another holder refuses with code 'locked'. */
  #locked() {
    if (!this.#lockP) {
      this.#lockP = this.#ensureDir().then(() => acquireLock({ fs: this.fs, file: this.#path(LOCK_FILE), ...this.lockAs }));
      this.#lockP.catch(() => {
        this.#lockP = null;
      });
    }
    return this.#lockP;
  }

  /** The key, made on first use under the folder lock; a failed load is not kept, so a later call tries again (the Keychain unlocked). */
  #key() {
    if (!this.available()) return Promise.reject(unavailableError());
    if (this.#erasing) return this.#erasing.then(() => this.#key());
    if (!this.#keyP) {
      this.#keyP = this.#locked().then(() =>
        loadAuditKey({
          file: this.#path(KEY_FILE),
          safe: this.safe,
          fs: this.fs,
          hasLog: async () => (await this.#files()).length > 0,
          ensureDir: () => this.#ensureDir(),
        }),
      );
      this.#keyP.catch(() => {
        this.#keyP = null;
      });
    }
    return this.#keyP;
  }

  /** The sealed checkpoint, or null when it is missing or can't be opened. */
  /** @returns {Promise<{ seq: number, mac: string } | null | 'unreadable'>} null: there is none */
  async #checkpoint() {
    let sealed;
    try {
      sealed = await this.fs.readFile(this.#path(HEAD_FILE), 'utf8');
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
    try {
      const cp = JSON.parse(/** @type {SafeStorage} */ (this.safe).decryptString(Buffer.from(sealed.trim(), 'base64')));
      return Number.isSafeInteger(cp?.seq) && typeof cp.mac === 'string' ? /** @type {{ seq: number, mac: string }} */ (cp) : 'unreadable';
    } catch {
      // tampered, sealed with another key, or the Keychain won't open it now: no checkpoint to trust
      return 'unreadable';
    }
  }

  /**
   * The last entry on disk. A line cut short at the very end (a write interrupted by a full disk or a quit) is removed and
   * counted in `cut`, to be recorded; a whole last line that doesn't check out is refused, so nothing is chained past it.
   */
  async #readHead(/** @type {Buffer} */ key) {
    const files = await this.#files();
    let cut = 0;
    for (let i = files.length - 1; i >= 0; i--) {
      const file = this.#path(files[i]);
      let text = await this.fs.readFile(file, 'utf8');
      if (!text.endsWith('\n') && text) {
        const keep = text.slice(0, text.lastIndexOf('\n') + 1);
        cut += Buffer.byteLength(text) - Buffer.byteLength(keep);
        await this.fs.truncate(file, Buffer.byteLength(keep));
        text = keep;
      }
      if (!text) continue;
      const corrupt = new AuditError('corrupt', `MoMo's audit log ${files[i]} ends in a damaged entry`);
      let last;
      try {
        last = JSON.parse(text.slice(text.lastIndexOf('\n', text.length - 2) + 1));
      } catch {
        throw corrupt;
      }
      if (!isJsonRecord(last) || !Number.isSafeInteger(last.seq) || !macMatches(key, last)) throw corrupt;
      const head = { seq: /** @type {number} */ (last.seq), mac: /** @type {string} */ (last.mac) };
      await this.#checkReached(head);
      return { ...head, cut };
    }
    await this.#checkReached({ seq: 0, mac: GENESIS });
    return { seq: 0, mac: GENESIS, cut };
  }

  /** Refuses to go on from an end older than the checkpoint: chaining past it would hide the entries cut from the end. */
  async #checkReached(/** @type {{ seq: number, mac: string }} */ head) {
    const cp = await this.#checkpoint();
    if (cp === 'unreadable') throw new AuditError('corrupt', "MoMo's audit checkpoint can't be read, so the log's end can't be checked");
    // the checkpoint may be behind (a crash between an entry and its checkpoint; verify() checks the entry it names), never ahead.
    // A log without one can only be a new one: every version that writes the log writes its checkpoint
    if (!(cp && cp.seq < head.seq) && !reaches(cp, new Map([[head.seq, head.mac]]), head.seq))
      throw new AuditError(
        'corrupt',
        `MoMo's audit log ends before its checkpoint (entry ${cp?.seq ?? 'unknown'}): entries were cut from the end`,
      );
  }

  /** Moves the full current file aside under the next number; returns the oldest files beyond maxFiles, to be removed once recorded. */
  async #rotate() {
    const rotated = (await this.#files()).filter((n) => n !== CURRENT);
    const next = rotated.length ? Number(/** @type {RegExpExecArray} */ (ROTATED.exec(rotated[rotated.length - 1]))[1]) + 1 : 1;
    const name = `audit.${String(next).padStart(6, '0')}.jsonl`;
    await this.fs.rename(this.#path(CURRENT), this.#path(name));
    const kept = [...rotated, name];
    // the new current file is one of the maxFiles
    const gone = kept.slice(0, Math.max(0, kept.length - (this.maxFiles - 1)));
    if (!gone.length) return null;
    // the last entry removed, so the chain can still be checked from the oldest file kept
    const text = await this.fs.readFile(this.#path(gone[gone.length - 1]), 'utf8');
    const last = JSON.parse(text.slice(text.lastIndexOf('\n', text.length - 2) + 1));
    return { gone, record: { files: gone.length, lastSeq: last.seq, lastMac: last.mac } };
  }

  /** Writes one entry and waits until it is on the disk. */
  #append(/** @type {Record<string, unknown>} */ fields) {
    return this.#queue(async () => {
      const key = await this.#key();
      await this.#ensureDir();
      // another writer on this folder moved the end since this log's last write
      if (this.#head && (await this.#currentSize()) !== this.#headSize) this.#head = null;
      if (!this.#head) {
        const { cut, ...head } = await this.#readHead(key);
        this.#head = head;
        this.#headSize = await this.#currentSize();
        if (cut)
          await this.#write(key, { kind: 'repair', id: this.newId(), note: `A write cut short (${cut} bytes) was removed from the end` });
      }
      return this.#write(key, fields);
    });
  }

  async #write(/** @type {Buffer} */ key, /** @type {Record<string, unknown>} */ fields) {
    if (this.#headSize >= this.maxBytes) {
      const pruned = await this.#rotate();
      this.#headSize = 0;
      if (pruned) {
        // the record first: a crash before the files go leaves them and a record, which still checks out
        await this.#write(key, { kind: 'pruned', id: this.newId(), ...pruned.record });
        for (const old of pruned.gone) await this.fs.rm(this.#path(old), { force: true });
      }
    }
    const head = /** @type {{ seq: number, mac: string }} */ (this.#head);
    const entry = { v: 1, seq: head.seq + 1, at: this.now(), ...fields, prev: head.mac };
    const line = `${JSON.stringify({ ...entry, mac: macOf(key, entry) })}\n`;
    // a write that fails half way leaves a cut end, which the next write reads (and records) instead of chaining past it
    this.#head = null;
    const fh = await this.fs.open(this.#path(CURRENT), 'a', 0o600);
    try {
      await fh.chmod(0o600);
      await fh.write(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const written = JSON.parse(line);
    this.#head = { seq: written.seq, mac: written.mac };
    this.#headSize += Buffer.byteLength(line);
    // after the entry: a crash in between leaves the checkpoint one entry behind, which still checks out
    const sealed = encryptForStore(this.safe, JSON.stringify(this.#head));
    if (!sealed.ok) throw unavailableError();
    await writeDurable(this.fs, this.#path(HEAD_FILE), `${sealed.value}\n`);
    return written;
  }

  #fields(/** @type {ActionFields} */ f) {
    if (!isJsonRecord(f)) throw new AuditError('input', 'an audit entry needs its fields');
    try {
      canonical(f.args ?? null);
    } catch {
      throw new AuditError('input', 'the arguments must be plain JSON');
    }
    return {
      action: label(f.action, 'action', true),
      chatId: label(f.chatId, 'chatId', true),
      harness: label(f.harness, 'harness'),
      account: label(f.account, 'account'),
      decision: label(f.decision, 'decision', true),
      // the paired device whose answer allowed or denied the action; left out of the entry when no device answered
      ...(f.device === undefined ? {} : { device: label(f.device, 'device', true) }),
    };
  }

  async #withDigest(/** @type {ActionFields} */ f, /** @type {Record<string, unknown>} */ fields) {
    const key = await this.#key();
    return { ...fields, args: argsDigest(key, f.args) };
  }

  /**
   * Records that an action is about to run and resolves once that is on the disk; the action runs only after.
   * @param {ActionFields} f
   * @returns {Promise<{ id: string, seq: number }>}
   */
  async intent(f) {
    const fields = this.#fields(f);
    const id = this.newId();
    const entry = await this.#append({ kind: 'intent', id, ...(await this.#withDigest(f, fields)) });
    this.#open.set(id, {
      action: fields.action,
      chatId: fields.chatId,
      harness: fields.harness,
      account: fields.account,
      ...(fields.device === undefined ? {} : { device: fields.device }),
    });
    return { id, seq: entry.seq };
  }

  /**
   * How the action of `intentId` ended. 'uncertain' is final: nothing here retries it.
   * @param {string} intentId
   * @param {{ result: string, note?: string }} o
   */
  async outcome(intentId, o) {
    const { result, note = '' } = o ?? /** @type {any} */ ({});
    const open = this.#open.get(intentId);
    if (!open) throw new AuditError('input', 'no open intent with that id');
    if (!RESULT_SET.has(result)) throw new AuditError('input', `result must be one of: ${[...RESULT_SET].join(', ')}`);
    if (typeof note !== 'string' || note.length > MAX_NOTE) throw new AuditError('input', 'note must be a short string');
    const entry = await this.#append({ kind: 'outcome', id: intentId, ...open, result, ...(note ? { note } : {}) });
    this.#open.delete(intentId);
    return { seq: entry.seq };
  }

  /** Records a call that was refused before anything ran (`decision` says why). */
  async refusal(/** @type {ActionFields} */ f) {
    const fields = this.#fields(f);
    const entry = await this.#append({ kind: 'refusal', id: this.newId(), ...(await this.#withDigest(f, fields)) });
    return { seq: entry.seq };
  }

  /** Calls `fn` with each file's text, oldest first, one file in memory at a time, after the writes queued before; `fn` returning a value stops there. */
  #eachFile(/** @type {(file: string, text: string, key: Buffer) => any} */ fn) {
    return this.#queue(async () => {
      const key = await this.#key();
      for (const file of await this.#files()) {
        const out = fn(file, await this.fs.readFile(this.#path(file), 'utf8'), key);
        if (out !== undefined) return out;
      }
      return undefined;
    });
  }

  /**
   * Checks every entry's HMAC, number and link to the one before, the removals rotation recorded and the sealed checkpoint;
   * reports the first one that breaks the chain (auditRead.cjs).
   * @returns {Promise<Verdict>}
   */
  async verify() {
    const check = chainChecker();
    const broken = await this.#eachFile((file, text, key) => check.file(file, text, key));
    return broken ?? check.end(await this.#checkpoint());
  }

  /** The whole log as JSONL, oldest first, exactly as written (each line with its HMAC). */
  async exportJsonl() {
    /** @type {string[]} */
    const parts = [];
    await this.#eachFile((_file, text) => void parts.push(text));
    return parts.join('');
  }

  /** Intents on disk with no outcome and not running in this process: their action may or may not have happened. */
  async unfinished() {
    const scan = unfinishedScanner((id) => this.#open.has(id));
    await this.#eachFile((_file, text, key) => void scan.file(text, key));
    return scan.end();
  }

  /** At startup: records every unfinished intent (the app quit while it ran) as uncertain, never as a retry. */
  async settleUnfinished() {
    const open = await this.unfinished();
    for (const { id, action, chatId, harness, account } of open)
      await this.#append({
        kind: 'outcome',
        id,
        action,
        chatId,
        harness,
        account,
        result: RESULTS.UNCERTAIN,
        note: 'MoPilot quit while this ran',
      });
    return open.length;
  }

  /**
   * Starts a new chain after the old one can't go on (its key was lost: a Keychain reset, a restored backup): the key and
   * every log file are set aside, untouched, in a `set-aside-<time>` folder, and the new chain starts with an entry naming it.
   * Only on the user's say-so; nothing calls it on its own.
   * @returns {Promise<string>} the folder the old log was set aside in
   */
  async startOver() {
    if (!this.available()) throw unavailableError();
    const aside = await this.#queue(async () => {
      await this.#locked();
      const name = `set-aside-${this.now()}`;
      await this.fs.mkdir(this.#path(name), { mode: 0o700 });
      for (const file of [...(await this.#files()), KEY_FILE, HEAD_FILE])
        try {
          await this.fs.rename(this.#path(file), this.#path(name, file));
        } catch (e) {
          if (!notFound(e)) throw e;
        }
      this.#keyP = null;
      this.#head = null;
      this.#open.clear();
      return name;
    });
    await this.#append({ kind: 'restart', id: this.newId(), note: `The earlier log was set aside in ${aside}` });
    return aside;
  }

  /** Lets go of the folder after everything queued has settled; the next write makes it again if it is gone, and takes it. */
  close() {
    return this.#queue(() => this.#letGo());
  }

  async #letGo() {
    const held = this.#lockP;
    this.#lockP = null;
    this.#keyP = null;
    this.#head = null;
    this.#dirReady = false;
    if (held) await (await held).release();
  }

  /**
   * Reset MoMo (#2307): after everything queued, the folder is let go and deleted with every file in it (key, lock,
   * checkpoint, log); the next entry starts a new folder, key and chain, so the log works again without a restart.
   */
  erase() {
    return this.#queue(() => {
      // a key being made now (an intent's digest, outside the queue) is written before the folder goes, and none is
      // made again until it has gone
      const erasing = (async () => {
        await this.#keyP?.catch(() => undefined);
        await this.#letGo();
        await this.fs.rm(this.dir, { recursive: true, force: true });
      })();
      this.#erasing = erasing.then(
        () => undefined,
        () => undefined,
      );
      return erasing.finally(() => {
        this.#erasing = null;
      });
    });
  }

  /** Resolves when everything queued so far has settled. */
  idle() {
    return this.#queue(async () => undefined);
  }
}

module.exports = { AuditLog, AuditError, RESULTS, GENESIS, CURRENT, KEY_FILE, LOCK_FILE, HEAD_FILE, MAX_BYTES, MAX_FILES };

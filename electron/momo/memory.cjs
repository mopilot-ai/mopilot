// MoMo's memory (#2139), on this Mac only and owned by MoPilot, so a harness or account switch keeps it and no harness's own memory holds it: about-you.md, persona.md and facts.jsonl under one folder (production: <userData>/momo, electron/momo/stores.cjs momoDir; folder 0700, files 0600), each document and each fact encrypted with Electron safeStorage (the key stays in the Keychain); without encryption nothing is read or written, never plain text. It reads and writes only those three files: never chats, transcripts, Computer History or a harness's own memory. A fact comes from a MoMo chat or from the user, nothing else. Reads are snapshots of the files; writes go through one queue and land by atomic rename; a line that can't be decrypted or read is skipped and kept as it was, a document that can't be decrypted is kept as <name>.unreadable-<time> before it is replaced; expired facts are left out of search and the summary and pruned on the next write; a fact a newer one replaced is kept as past (invalidAt) and left out the same way; every change to the facts is logged (memoryLog.cjs, changes.jsonl) and can be undone; at most MAX_FACTS facts in use, a storage guard only (older facts fade in ranking, strength in memoryFacts.cjs). Decrypted facts are cached until the file changes.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fs: nodeFs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../platform/fsutil.cjs');
const { encryptForStore, canEncrypt } = require('../platform/encryptedStore.cjs');
const {
  MemoryError,
  UNAVAILABLE,
  MAX_FACT,
  sourceOf,
  isFact,
  sameText,
  factText,
  confidenceOf,
  expiryOf,
  rankFacts,
  strength,
  estimateTokens,
  clipTokens,
} = require('./memoryFacts.cjs');
const { CHANGES_FILE, isChange, changed, appended, current, applyPass, undoChange } = require('./memoryLog.cjs');

/** The two documents the user edits, by the name the API takes. */
const FILES = Object.freeze({ aboutYou: 'about-you.md', persona: 'persona.md' });
const FACTS_FILE = 'facts.jsonl';
/** The longest document kept. */
const MAX_FILE = 20000;
/** About how many tokens a turn's memory may take. */
const SUMMARY_BUDGET = 2000;
/** The most facts in use kept, a guard on the file's size: a save past it is refused until some are forgotten. */
const MAX_FACTS = 5000;

/**
 * @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage
 * @typedef {import('./memoryFacts.cjs').Fact} Fact
 * @typedef {import('./memoryFacts.cjs').FactSource} FactSource
 * @typedef {{ fact: Fact } | { raw: string }} Line a fact, or a line that could not be read (written back as it was)
 * @typedef {import('./memoryLog.cjs').Change} Change
 * @typedef {import('./memoryLog.cjs').ChangeBy} ChangeBy
 * @typedef {import('./memoryLog.cjs').ChangeItem} ChangeItem
 */

/** Emits 'changed' after every write that reached the disk (the Memory tab reads again). */
class MemoryStore extends EventEmitter {
  /**
   * @param {{ dir: string, safeStorage: SafeStorage | null, isMomoChat?: (chatId: string) => boolean, now?: () => number,
   *           newId?: () => string, fs?: typeof nodeFs, aliases?: () => (f: Fact) => string }} o
   *   safeStorage: Electron's (main passes it; tests a fake); isMomoChat: the chats a fact may come from (none without it);
   *   aliases: the facts' search aliases for one search (factAliases.cjs lookup), matched and never returned
   */
  constructor({
    dir,
    safeStorage,
    isMomoChat = () => false,
    now = Date.now,
    newId = () => crypto.randomUUID(),
    fs = nodeFs,
    aliases = () => () => '',
  }) {
    super();
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error("MoMo's memory needs an absolute folder");
    this.dir = dir;
    this.safe = safeStorage ?? null;
    this.isMomoChat = isMomoChat;
    this.now = now;
    this.newId = newId;
    this.fs = fs;
    this.aliases = aliases;
    /** @type {Promise<unknown>} the end of the write queue */
    this.tail = Promise.resolve();
  }

  /** Runs `fn` after every write queued before it; one write's failure does not stop the next. */
  #queue(/** @type {() => any} */ fn) {
    const run = this.tail.then(fn);
    // the write's own caller gets its failure; the queue only waits for it to settle
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #path(/** @type {string} */ name) {
    return path.join(this.dir, name);
  }

  /** Whether this Mac can encrypt the memory now; without it nothing is read or written. */
  available() {
    return canEncrypt(this.safe);
  }

  #requireAvailable() {
    if (!this.available()) throw new MemoryError(UNAVAILABLE, 'unavailable');
  }

  /** `text` encrypted, as base64; a MemoryError when it can't be. */
  #seal(/** @type {string} */ text) {
    const sealed = encryptForStore(this.safe, text);
    if (!sealed.ok) throw new MemoryError(UNAVAILABLE, 'unavailable');
    return sealed.value;
  }

  /** The text of base64 `sealed`, or null when it can't be decrypted (tampered, or another key). */
  #open(/** @type {string} */ sealed) {
    try {
      return /** @type {SafeStorage} */ (this.safe).decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      return null;
    }
  }

  /** The raw text of a file, '' when it is missing; any other read error is thrown, so nothing is written over it. */
  #read(/** @type {string} */ name) {
    this.#requireAvailable();
    try {
      return this.fs.readFileSync(this.#path(name), 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return '';
      throw error;
    }
  }

  #write(/** @type {string} */ name, /** @type {string} */ data, emit = true) {
    this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // a folder made earlier (or by hand) is made owner-only too
    this.fs.chmodSync(this.dir, 0o700);
    writePrivate(this.#path(name), data, this.fs);
    if (emit) this.emit('changed');
  }

  /** What tells one state of the facts file from another: a change by anyone moves it. */
  #stamp() {
    const st = this.fs.statSync(this.#path(FACTS_FILE), { throwIfNoEntry: false });
    return st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'none';
  }

  /** @returns {Line[]} each line one encrypted fact, decrypted once per state of the file */
  #lines() {
    this.#requireAvailable();
    const stamp = this.#stamp();
    if (this.cache?.stamp !== stamp) this.cache = { stamp, lines: this.#parse() };
    return [...this.cache.lines];
  }

  /** @returns {Line[]} */
  #parse() {
    return this.#read(FACTS_FILE)
      .split('\n')
      .filter((l) => l.trim())
      .map((raw) => {
        const text = this.#open(raw.trim());
        try {
          const fact = text === null ? null : JSON.parse(text);
          return isFact(fact) ? { fact } : { raw };
        } catch {
          return { raw };
        }
      });
  }

  /** Writes the lines, less the facts that have expired (a line that can't be read is kept as it was). */
  #saveLines(/** @type {Line[]} */ lines) {
    const now = this.now();
    const kept = lines.filter((l) => !('fact' in l) || this.#live(l.fact, now));
    this.#write(FACTS_FILE, kept.map((l) => ('fact' in l ? this.#seal(JSON.stringify(l.fact)) : l.raw) + '\n').join(''));
    this.cache = null;
  }

  #live(/** @type {Fact} */ f, now = this.now()) {
    return f.expiresAt === undefined || f.expiresAt > now;
  }

  /**
   * The facts, newest first, and how many lines could not be read. Expired facts only with `includeExpired`, facts a
   * newer one replaced only with `includePast`.
   * @param {{ includeExpired?: boolean, includePast?: boolean }} [o]
   * @returns {{ facts: Fact[], unreadable: number }}
   */
  list({ includeExpired = false, includePast = false } = {}) {
    const lines = this.#lines();
    const now = this.now();
    const shown = (/** @type {Fact} */ f) => (includeExpired || this.#live(f, now)) && (includePast || f.invalidAt === undefined);
    const facts = lines.flatMap((l) => ('fact' in l && shown(l.fact) ? [l.fact] : []));
    return { facts: facts.sort((a, b) => b.createdAt - a.createdAt), unreadable: lines.length - lines.filter((l) => 'fact' in l).length };
  }

  /**
   * The unexpired facts that share words with `query`, the best first (more words matched, then sure before likely,
   * then newer); every unexpired fact, newest first, for an empty query.
   * @param {string} query
   * @param {{ limit?: number }} [o]
   * @returns {Fact[]}
   */
  search(query, { limit = 10 } = {}) {
    return rankFacts(this.list().facts, query, limit, this.now(), this.aliases());
  }

  /**
   * The newest changes first (a line of changes.jsonl that can't be read is skipped).
   * @returns {Change[]}
   */
  changes() {
    return this.#changes().reverse();
  }

  /** @returns {Change[]} oldest first */
  #changes() {
    return this.#read(CHANGES_FILE)
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((raw) => {
        const text = this.#open(raw.trim());
        try {
          const entry = text === null ? null : JSON.parse(text);
          return isChange(entry) ? [entry] : [];
        } catch {
          return [];
        }
      });
  }

  /**
   * Writes `lines` and logs what changed in them as one entry by `by` (nothing is logged when nothing changed).
   * @param {Line[]} lines
   * @param {{ by: ChangeBy, op: Change['op'], items: ChangeItem[], reason?: string, entries?: Change[] }} o
   * @returns {Change | null}
   */
  #commit(lines, { by, op, items, reason, entries }) {
    this.#saveLines(lines);
    const real = changed(items);
    if (!real.length) return null;
    /** @type {Change} */
    // its own kind of id, so the facts' ids stay as they were
    const entry = { id: crypto.randomUUID(), at: this.now(), by, op, items: real, ...(reason ? { reason } : {}) };
    const log = appended(entries ?? this.#changes(), entry);
    this.#write(CHANGES_FILE, log.map((c) => this.#seal(JSON.stringify(c)) + '\n').join(''), false);
    return entry;
  }

  /**
   * A background pass's changes from the MoMo chat `source` (memoryLog.cjs applyPass: never a fact the user wrote, at
   * most a fifth of the facts in use changed, a replaced fact kept as past), logged as one change by 'pass'.
   * @param {import('./memoryLog.cjs').PassOp[]} ops
   * @param {{ source: FactSource, reason?: string }} o
   * @returns {Promise<{ change: Change | null, skipped: import('./memoryLog.cjs').Skipped[] }>}
   */
  async applyPass(ops, { source, reason }) {
    this.#requireAvailable();
    return this.#queue(() => {
      const now = this.now();
      const done = applyPass(this.#lines(), ops, { source, isMomoChat: this.isMomoChat, now, newId: this.newId });
      this.#guard(done.lines, now);
      const change = done.items.length ? this.#commit(done.lines, { by: 'pass', op: 'pass', items: done.items, reason }) : null;
      return { change, skipped: done.skipped };
    });
  }

  /**
   * Undoes the change `id`: each fact it touched back as it was, logged as an undo by `by`. A MemoryError (changed)
   * when one of those facts changed since, when it was undone already, or when there is no such change in the log.
   * @param {string} id
   * @param {{ by?: ChangeBy }} [o]
   * @returns {Promise<Change>}
   */
  undo(id, { by = 'user' } = {}) {
    return this.#queue(() => {
      const entries = this.#changes();
      const at = entries.findIndex((c) => c.id === id);
      if (at < 0) throw new MemoryError('That change is no longer in the log', 'changed');
      const done = undoChange(this.#lines(), entries[at]);
      entries[at] = { ...entries[at], undone: this.now() };
      return /** @type {Change} */ (this.#commit(done.lines, { by, op: 'undo', items: done.items, entries }));
    });
  }

  /** Refuses `lines` with more facts in use than MAX_FACTS (a storage guard; the pass and a save both check it). */
  #guard(/** @type {Line[]} */ lines, /** @type {number} */ now) {
    if (lines.filter((l) => 'fact' in l && current(l.fact, now)).length > MAX_FACTS)
      throw new MemoryError(`MoMo's memory is full (${MAX_FACTS} facts). Forget some first.`, 'full');
  }

  /**
   * Saves a fact, unless one with the same text is kept already: that one is returned (an expired one comes back with
   * this save's source, time, confidence and expiry).
   * @param {{ text: unknown, source: FactSource, confidence?: unknown, expiresAt?: unknown }} input
   * `saved`: false when the same text was kept already and nothing was written.
   * @returns {Promise<{ fact: Fact, saved: boolean }>}
   */
  async save(input) {
    const text = factText(input?.text);
    const confidence = confidenceOf(input?.confidence);
    const expiresAt = expiryOf(input?.expiresAt) ?? undefined;
    const source = sourceOf(input?.source, this.isMomoChat);
    this.#requireAvailable();
    return this.#queue(() => {
      const lines = this.#lines();
      const now = this.now();
      const at = lines.findIndex((l) => 'fact' in l && sameText(l.fact.text) === sameText(text));
      const same = at >= 0 ? /** @type {{ fact: Fact }} */ (lines[at]).fact : null;
      if (same && current(same, now)) return { fact: same, saved: false };
      if (!same && lines.filter((l) => 'fact' in l && current(l.fact, now)).length >= MAX_FACTS)
        throw new MemoryError(`MoMo's memory is full (${MAX_FACTS} facts). Forget some first.`, 'full');
      /** @type {Fact} */
      const fact = {
        id: same?.id ?? this.newId(),
        text,
        source,
        createdAt: now,
        confidence,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
      if (same) lines[at] = { fact };
      else lines.push({ fact });
      this.#commit(lines, { by: source, op: 'save', items: [{ before: same, after: fact }] });
      return { fact, saved: true };
    });
  }

  /**
   * Changes a fact's text, confidence or expiry (null clears it); null when there is no such fact, or when it has
   * expired and the change leaves it expired (it is pruned). Text another fact has already is refused, as a save
   * would keep it once.
   * @param {string} id
   * @param {{ text?: unknown, confidence?: unknown, expiresAt?: unknown }} patch
   * @param {{ by?: ChangeBy }} [o] who changes it, for the change log
   * @returns {Promise<Fact | null>}
   */
  async update(id, patch, { by = 'user' } = {}) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const text = p.text === undefined ? undefined : factText(p.text);
    const confidence = p.confidence === undefined ? undefined : confidenceOf(p.confidence);
    const expiresAt = expiryOf(p.expiresAt);
    return this.#queue(() => {
      const lines = this.#lines();
      const at = lines.findIndex((l) => 'fact' in l && l.fact.id === id);
      if (at < 0) return null;
      if (text !== undefined && lines.some((l) => 'fact' in l && l.fact.id !== id && sameText(l.fact.text) === sameText(text)))
        throw new MemoryError('Another fact already says this');
      const before = /** @type {{ fact: Fact }} */ (lines[at]).fact;
      const { expiresAt: oldExpiry, ...was } = before;
      const kept = expiresAt === undefined ? oldExpiry : (expiresAt ?? undefined);
      /** @type {Fact} */
      const fact = {
        ...was,
        ...(text !== undefined ? { text } : {}),
        ...(confidence ? { confidence } : {}),
        ...(kept !== undefined ? { expiresAt: kept } : {}),
      };
      lines[at] = { fact };
      this.#commit(lines, { by, op: 'update', items: [{ before, after: fact }] });
      return this.#live(fact) ? fact : null;
    });
  }

  /**
   * Removes a fact; the fact removed, or null when there was none.
   * @param {string} id
   * @param {{ by?: ChangeBy }} [o] who removes it, for the change log
   * @returns {Promise<Fact | null>}
   */
  forget(id, { by = 'user' } = {}) {
    return this.#queue(() => {
      const lines = this.#lines();
      const at = lines.findIndex((l) => 'fact' in l && l.fact.id === id);
      if (at < 0) return null;
      const [gone] = lines.splice(at, 1);
      const fact = /** @type {{ fact: Fact }} */ (gone).fact;
      this.#commit(lines, { by, op: 'forget', items: [{ before: fact, after: null }] });
      return fact;
    });
  }

  /**
   * A document's text, '' when there is none; a MemoryError (unreadable) when it can't be decrypted.
   * @param {keyof typeof FILES} name
   */
  readFile(name) {
    if (!Object.hasOwn(FILES, name)) throw new MemoryError(`No such memory file: ${name}`);
    const sealed = this.#read(FILES[name]).trim();
    if (!sealed) return '';
    const text = this.#open(sealed);
    if (text === null) throw new MemoryError(`${FILES[name]} can't be decrypted on this Mac`, 'unreadable');
    return text;
  }

  /**
   * @param {keyof typeof FILES} name
   * @param {unknown} text
   * @returns {Promise<void>}
   */
  async writeFile(name, text) {
    if (!Object.hasOwn(FILES, name)) throw new MemoryError(`No such memory file: ${name}`);
    if (typeof text !== 'string') throw new MemoryError('The file text must be a string');
    if (text.length > MAX_FILE) throw new MemoryError(`A memory file is at most ${MAX_FILE} characters`);
    this.#requireAvailable();
    return this.#queue(() => {
      const sealed = this.#seal(text);
      const file = this.#path(FILES[name]);
      const was = this.#read(FILES[name]).trim();
      // one that can't be decrypted is kept beside it (a Keychain restored later may open it), never just replaced;
      // each such copy gets its own name
      if (was && this.#open(was) === null) this.#keepCopy(file);
      this.#write(FILES[name], sealed);
    });
  }

  /** A copy of `file` as `<file>.unreadable-<time>` (then -2, -3… when that name is taken). */
  #keepCopy(/** @type {string} */ file) {
    const base = `${file}.unreadable-${this.now()}`;
    let n = 1;
    while (!this.#copyAs(file, n === 1 ? base : `${base}-${n}`)) if (++n > 100) throw new Error(`No free name for a copy of ${file}`);
  }

  /** Copies `file` to `to` unless `to` exists (false then); any other failure is thrown. */
  #copyAs(/** @type {string} */ file, /** @type {string} */ to) {
    try {
      this.fs.copyFileSync(file, to, this.fs.constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
      return false;
    }
  }

  /**
   * What a MoMo turn is told, within `budgetTokens` (estimated): the persona and about the user (each at most a third,
   * clipped), then the unexpired facts most relevant to `query` (all of them by sure first and recency without one)
   * as lines, as many as fit.
   * @param {{ budgetTokens?: number, query?: string, excludeOrigins?: string[] }} [o]
   * @returns {{ persona: string, aboutYou: string, facts: string[] }}
   */
  summary({ budgetTokens = SUMMARY_BUDGET, query = '', excludeOrigins = [] } = {}) {
    const budget = Math.max(0, Math.floor(budgetTokens) || 0);
    const third = Math.floor(budget / 3);
    // a document that can't be decrypted is left out; the facts still go
    const read = (/** @type {keyof typeof FILES} */ name) => {
      try {
        return this.readFile(name).trim();
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'unreadable') return '';
        throw error;
      }
    };
    const persona = clipTokens(read('persona'), third);
    const aboutYou = clipTokens(read('aboutYou'), third);
    // `excludeOrigins`: facts MoMo inferred itself (origin 'extracted') can be left out, for a reader that must not act on what a background pass wrote from outside text
    const facts = this.list().facts.filter((f) => !excludeOrigins.includes(f.origin ?? ''));
    const now = this.now();
    const ranked = String(query ?? '').trim() ? rankFacts(facts, query, 50, now, this.aliases()) : [];
    const first = new Set(ranked.map((f) => f.id));
    const rest = [...facts].sort((a, b) => strength(b, now) - strength(a, now) || b.createdAt - a.createdAt);
    const order = [...ranked, ...rest.filter((f) => !first.has(f.id))];
    let used = estimateTokens(persona) + estimateTokens(aboutYou);
    const lines = [];
    for (const f of order) {
      const line = `- ${f.text}${f.confidence === 'likely' ? ' (likely)' : ''}`;
      const cost = estimateTokens(line) + 1;
      if (used + cost > budget) continue;
      used += cost;
      lines.push(line);
    }
    return { persona, aboutYou, facts: lines };
  }

  /** Resolves once every write queued so far has settled. */
  idle() {
    return this.tail.then(() => undefined);
  }
}

module.exports = { MemoryStore, MemoryError, FILES, FACTS_FILE, MAX_FACT, MAX_FACTS, MAX_FILE, SUMMARY_BUDGET, UNAVAILABLE, isFact };

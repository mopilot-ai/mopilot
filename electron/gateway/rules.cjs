// The gateway's tool rules as the user keeps them (#2999 C3, shared/toolRules.mjs decides with them): one JSON file of the gateway's own, `<userData>/gateway/rules.json` (no secrets in it), written whole and durably (durableWrite.cjs), each change read-changed-written holding the file's lock (another MoPilot's change waits, fileLock.cjs) and one at a time here, so two writers' rules both survive (W1). A file that can't be parsed keeps the rules last read and says so (W3): it is never read as no rules (those would drop the user's blocks): the blocks and asks last read hold, nothing is allowed without asking until it is fixed or reset, no change overwrites it, and a reset keeps it aside (for 30 days). An entry this build doesn't understand is kept in the file as it is and counted.
const path = require('node:path');
const crypto = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const { writeDurable } = require('./durableWrite.cjs');
const { withLock, privateDir, pruneAside } = require('./sealedFile.cjs');
const { ruleOf } = require('../../shared/toolRules.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {import('../../shared/toolRules.mjs').ToolRule} ToolRule
 * @typedef {ToolRule & { id: string, createdAt: number }} SavedRule
 * @typedef {{ rules: SavedRule[], state: 'ok' | 'unreadable', invalid: number }} RulesView
 */

/** A change asked for while the file can't be read: nothing is written over it. */
class RulesUnreadableError extends Error {
  constructor() {
    super('The gateway’s rules file can’t be read, so no rule was changed. Reset the rules to start again.');
    this.code = 'rules_unreadable';
  }
}

/** A saved rule (with its id and time), or null. @returns {SavedRule | null} */
function savedRuleOf(/** @type {any} */ v) {
  const r = ruleOf(v);
  const id = typeof v?.id === 'string' && /^[a-z0-9-]{1,64}$/.test(v.id) ? v.id : null;
  return r && id && Number.isFinite(v.createdAt) ? { ...r, id, createdAt: v.createdAt } : null;
}

class RulesStore {
  /** @param {{ file: string, now?: () => number, lockWaitMs?: number }} o */
  constructor({ file, now = Date.now, lockWaitMs = 500 }) {
    this.file = file;
    this.now = now;
    this.lockWaitMs = lockWaitMs;
    /** @type {{ stamp: string, raw: unknown[], rules: SavedRule[] }} the last file read that parsed */
    this.good = { stamp: '', raw: [], rules: [] };
    /** whether the file as it is now couldn't be parsed, and its stamp then (not parsed again until it changes) */
    this.unreadable = false;
    this.badStamp = '';
    /** @type {Promise<unknown>} this process's changes, in order */
    this.queue = Promise.resolve();
  }

  /** The file's size and time, to read it again only when it changed (another MoPilot's write); '' when there is none. */
  #stamp() {
    try {
      const s = fs.statSync(this.file);
      // every write is a rename of a new file: its inode changes even when its size and time don't
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return '';
      throw error;
    }
  }

  /** Reads the file when it changed: a parsed one replaces the last good state; an unparsed one keeps it, marked. */
  #refresh() {
    let stamp;
    try {
      stamp = this.#stamp();
    } catch {
      this.unreadable = true;
      return;
    }
    if (stamp === this.good.stamp && !this.unreadable) return;
    if (this.unreadable && stamp && stamp === this.badStamp) return;
    if (!stamp) {
      this.good = { stamp, raw: [], rules: [] };
      this.unreadable = false;
      return;
    }
    let raw;
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (v?.v !== 1 || !Array.isArray(v.rules)) throw new Error('not a rules file');
      raw = v.rules;
    } catch {
      this.unreadable = true;
      this.badStamp = stamp;
      return;
    }
    const rules = /** @type {SavedRule[]} */ (raw.map(savedRuleOf).filter(Boolean));
    this.good = { stamp, raw, rules };
    this.unreadable = false;
  }

  /** The rules as they are now, whether the file could be read, and how many entries this build couldn't. @returns {RulesView} */
  view() {
    this.#refresh();
    const invalid = this.good.raw.length - this.good.rules.length;
    return { rules: this.good.rules.map((r) => ({ ...r })), state: this.unreadable ? 'unreadable' : 'ok', invalid };
  }

  /**
   * Runs one change of the rules (read fresh, changed, written whole) holding the lock, after this process's earlier ones.
   * @template R @param {(raw: unknown[]) => R} fn @returns {Promise<R>}
   */
  #change(fn) {
    const run = async () => {
      privateDir(path.dirname(this.file));
      return withLock(
        this.file,
        async () => {
          this.#refresh();
          if (this.unreadable) throw new RulesUnreadableError();
          const raw = [...this.good.raw];
          const out = fn(raw);
          await writeDurable(fs.promises, this.file, `${JSON.stringify({ v: 1, rules: raw }, null, 2)}\n`);
          this.good = { stamp: this.#stamp(), raw, rules: /** @type {SavedRule[]} */ (raw.map(savedRuleOf).filter(Boolean)) };
          return out;
        },
        { waitMs: this.lockWaitMs },
      );
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Adds a rule; resolves with it (its id and time given here). A rule the same as one saved (two "Always allow"s at once)
   * adds nothing and resolves with the saved one, decided in the same change. @returns {Promise<SavedRule>}
   */
  add(/** @type {unknown} */ rule) {
    const r = ruleOf(rule);
    if (!r) return Promise.reject(new Error('Not a rule: it needs a server, a tool pattern, a stance and a scope'));
    const key = JSON.stringify(ruleOf(r));
    const saved = { ...r, id: crypto.randomUUID(), createdAt: this.now() };
    return this.#change((raw) => {
      const same = raw.map(savedRuleOf).find((x) => x && JSON.stringify(ruleOf(x)) === key);
      if (same) return same;
      raw.push(saved);
      return saved;
    });
  }

  /** Removes a rule by its id; one already gone is not an error. */
  remove(/** @type {string} */ id) {
    return this.#change((raw) => {
      const i = raw.findIndex((x) => /** @type {any} */ (x)?.id === id);
      if (i >= 0) raw.splice(i, 1);
    });
  }

  /** Starts again with no rules: an unreadable file is kept aside (renamed), never deleted; a readable one is emptied. */
  reset() {
    const run = async () => {
      privateDir(path.dirname(this.file));
      return withLock(
        this.file,
        async () => {
          this.#refresh();
          if (this.unreadable)
            await fs.promises.rename(this.file, `${this.file}.unreadable-${this.now()}-${crypto.randomUUID().slice(0, 8)}`);
          await writeDurable(fs.promises, this.file, `${JSON.stringify({ v: 1, rules: [] }, null, 2)}\n`);
          // copies set aside more than 30 days ago go (sealedFile.cjs pruneAside, as the sealed stores keep theirs)
          // the reset has happened whatever the pruning does
          await pruneAside(this.file, this.now()).catch((error) => noteIgnored('prune old copies of the gateway’s rules', error));
          this.good = { stamp: this.#stamp(), raw: [], rules: [] };
          this.unreadable = false;
          this.badStamp = '';
        },
        { waitMs: this.lockWaitMs },
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

module.exports = { RulesStore, RulesUnreadableError, savedRuleOf };

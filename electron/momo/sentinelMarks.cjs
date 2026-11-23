// What MoMo's sentinel remembers about each chat besides approvals (#2139), keyed by the stable MoPilot chat id so it survives a harness switch: the private sources the chat has read (its taint), the hosts it opened (which it may still send to after a private read, #2283) and, per exact action, how many runs are still going and how many ended uncertain. Both are stored with the approvals, so a restart keeps them; a run that was still going when the app quit counts as uncertain.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const MAX_ID = 200;

/** @typedef {{ running: number, uncertain: number }} Runs */
/** @typedef {{ taint: Record<string, string[]>, runs: Record<string, Record<string, Runs>>, opened: Record<string, string[]> }} StoredMarks */

const id = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const count = (/** @type {unknown} */ v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) > 0 ? /** @type {number} */ (v) : 0);

class ChatMarks {
  /** @type {Map<string, Set<string>>} chat -> the private sources it read */
  #taint = new Map();
  /** @type {Map<string, Map<string, Runs>>} chat -> fingerprint -> its runs */
  #runs = new Map();
  /** @type {Map<string, Set<string>>} chat -> the hosts it opened (#2283), which it may still send to after a private read */
  #opened = new Map();

  /** The chat opened `host`; true when it hadn't before. */
  markOpened(/** @type {string} */ chatId, /** @type {string} */ host) {
    const set = this.#opened.get(chatId) ?? new Set();
    if (set.has(host)) return false;
    set.add(host);
    this.#opened.set(chatId, set);
    return true;
  }

  /** Whether the chat opened `host`. */
  wasOpened(/** @type {string} */ chatId, /** @type {string} */ host) {
    return this.#opened.get(chatId)?.has(host) === true;
  }

  /** Marks the chat as having read `source`; true when it hadn't before. */
  taint(/** @type {string} */ chatId, /** @type {string} */ source) {
    const set = this.#taint.get(chatId) ?? new Set();
    if (set.has(source)) return false;
    set.add(source);
    this.#taint.set(chatId, set);
    return true;
  }

  tainted(/** @type {string} */ chatId) {
    return this.#taint.has(chatId);
  }

  taintOf(/** @type {string} */ chatId) {
    return [...(this.#taint.get(chatId) ?? [])];
  }

  #runsOf(/** @type {string} */ chatId, /** @type {string} */ fp) {
    const byFp = this.#runs.get(chatId) ?? new Map();
    this.#runs.set(chatId, byFp);
    const r = byFp.get(fp) ?? { running: 0, uncertain: 0 };
    byFp.set(fp, r);
    return r;
  }

  #tidy(/** @type {string} */ chatId, /** @type {string} */ fp) {
    const byFp = /** @type {Map<string, Runs>} */ (this.#runs.get(chatId));
    const r = /** @type {Runs} */ (byFp.get(fp));
    if (!r.running && !r.uncertain) byFp.delete(fp);
    if (!byFp.size) this.#runs.delete(chatId);
  }

  /**
   * A run of the action starts; `fresh`: the user said yes knowing earlier runs were uncertain, which clears them.
   * @returns {Runs} the runs before, for undo()
   */
  started(/** @type {string} */ chatId, /** @type {string} */ fp, fresh = false) {
    const r = this.#runsOf(chatId, fp);
    const before = { ...r };
    if (fresh) r.uncertain = 0;
    r.running++;
    return before;
  }

  /** Takes back a start that couldn't be stored. */
  undo(/** @type {string} */ chatId, /** @type {string} */ fp, /** @type {Runs} */ before) {
    const r = this.#runsOf(chatId, fp);
    r.running = Math.max(0, r.running - 1);
    r.uncertain = Math.max(r.uncertain, before.uncertain);
    this.#tidy(chatId, fp);
  }

  /** A run ended: 'uncertain' keeps counting until a fresh yes; 'done' and 'not sent' end it. */
  ended(/** @type {string} */ chatId, /** @type {string} */ fp, /** @type {string} */ result) {
    const r = this.#runsOf(chatId, fp);
    if (r.running) r.running--;
    if (result === 'uncertain') r.uncertain++;
    this.#tidy(chatId, fp);
  }

  /** Whether a run of the action is still going or ended uncertain. */
  pending(/** @type {string} */ chatId, /** @type {string} */ fp) {
    const r = this.#runs.get(chatId)?.get(fp);
    return !!r && r.running + r.uncertain > 0;
  }

  /** Forgets the chat; true when there was something to forget. */
  clear(/** @type {string} */ chatId) {
    const had = [this.#taint.delete(chatId), this.#opened.delete(chatId)].includes(true);
    return this.#runs.delete(chatId) || had;
  }

  /** @returns {StoredMarks} */
  toJSON() {
    const runs = Object.fromEntries(
      [...this.#runs].map(([chatId, byFp]) => [chatId, Object.fromEntries([...byFp].map(([fp, r]) => [fp, { ...r }]))]),
    );
    const lists = (/** @type {Map<string, Set<string>>} */ m) => Object.fromEntries([...m].map(([chatId, set]) => [chatId, [...set]]));
    return { taint: lists(this.#taint), runs, opened: lists(this.#opened) };
  }

  /** Adds what storage holds; what can't be read is left out. A run that was still going is uncertain now: the app quit while it ran. */
  restore(/** @type {unknown} */ taint, /** @type {unknown} */ runs, /** @type {unknown} */ opened = undefined) {
    const each = (/** @type {unknown} */ v, /** @type {(chatId: string, x: string) => unknown} */ add) => {
      for (const [chatId, list] of Object.entries(isJsonRecord(v) ? /** @type {object} */ (v) : {}))
        if (id(chatId) && Array.isArray(list)) for (const x of list) if (id(x)) add(chatId, x);
    };
    each(taint, (chatId, source) => this.taint(chatId, source));
    each(opened, (chatId, host) => this.markOpened(chatId, host));
    for (const [chatId, byFp] of Object.entries(isJsonRecord(runs) ? /** @type {object} */ (runs) : {})) {
      if (!id(chatId) || !isJsonRecord(byFp)) continue;
      for (const [fp, r] of Object.entries(byFp)) {
        if (!/^[0-9a-f]{64}$/.test(fp) || !isJsonRecord(r)) continue;
        const n = count(r.running) + count(r.uncertain);
        if (!n) continue;
        this.#runsOf(chatId, fp).uncertain += n;
      }
    }
  }
}

module.exports = { ChatMarks };

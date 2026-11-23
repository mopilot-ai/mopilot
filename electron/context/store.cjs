// The context snapshots main keeps on disk (<userData>/context-snapshots.json): the latest per owner, the most recent few hundred, written off the main thread a few seconds after a change, and in full at quit.
const { fs } = require('../platform/ports/fs.cjs');
const { readJsonRecord, writeAtomic, writeAtomicAsync } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** Owners kept; older ones go first. */
const MAX_OWNERS = 400;
/** How long after a change the file is written (a streaming turn reports tokens often, and the file is large: one write for all of them). */
const WRITE_MS = 3000;

/** @typedef {import('../../shared/contextSnapshot.mjs').ContextSnapshot} ContextSnapshot */

class ContextStore {
  /**
   * @param {object} o
   * @param {() => string} o.file read when the store first loads or writes: main sets userData after making this
   * @param {{ readFile?: typeof readJsonRecord, write?: typeof writeAtomic, writeAsync?: typeof writeAtomicAsync, setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout }} [o.io]
   */
  constructor(o) {
    this.file = o.file;
    this.readFile = o.io?.readFile ?? readJsonRecord;
    this.write = o.io?.write ?? writeAtomic;
    this.writeAsync = o.io?.writeAsync ?? writeAtomicAsync;
    /** Counts the writes started: a quit flush or a newer write outdates one still on its way. */
    this.seq = 0;
    this.setTimer = o.io?.setTimer ?? setTimeout;
    this.clearTimer = o.io?.clearTimer ?? clearTimeout;
    /** @type {Map<string, ContextSnapshot> | null} loaded on first use, in least recently changed order */
    this.map = null;
    this.timer = null;
  }

  /** @returns {Map<string, ContextSnapshot>} */
  loaded() {
    if (this.map) return this.map;
    this.map = new Map();
    const saved = this.readFile(this.file(), null);
    const owners = saved?.v === 1 && saved.owners && typeof saved.owners === 'object' ? saved.owners : {};
    const rows = Object.entries(owners).filter(([owner, s]) => s && typeof s === 'object' && s.owner === owner);
    rows.sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0));
    for (const [owner, s] of rows.slice(-MAX_OWNERS)) this.map.set(owner, s);
    return this.map;
  }

  /** @param {string} owner @returns {ContextSnapshot | null} */
  get(owner) {
    return this.loaded().get(owner) ?? null;
  }

  /** @param {ContextSnapshot} s */
  put(s) {
    const map = this.loaded();
    map.delete(s.owner);
    map.set(s.owner, s);
    while (map.size > MAX_OWNERS) map.delete(map.keys().next().value);
    if (!this.timer) this.timer = this.setTimer(() => this.save(), WRITE_MS);
  }

  /** The timer fired: the file is written without holding up the main thread. */
  save() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.map) return;
    const n = ++this.seq;
    this.writeAsync(this.file(), this.bytes(), () => n === this.seq).catch((error) => {
      // the next report writes it again
      noteIgnored('save the context snapshots', error);
    });
  }

  bytes() {
    return JSON.stringify({ v: 1, owners: Object.fromEntries(/** @type {Map<string, ContextSnapshot>} */ (this.map)) });
  }

  /** Write what changed now (at quit): a write still on its way is outdated by it. */
  flush() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.map) return;
    this.seq++;
    try {
      this.write(this.file(), this.bytes(), fs);
    } catch (error) {
      // the snapshots are rebuilt by the next reports; one not written is read again when its chat reports
      noteIgnored('save the context snapshots', error);
    }
  }
}

module.exports = { ContextStore, MAX_OWNERS, WRITE_MS };

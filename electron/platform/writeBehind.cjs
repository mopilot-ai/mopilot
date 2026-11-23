// Write-behind for DERIVED state main keeps in memory (ui-state.json, the legacy mirror of the chat list): a change marks its file dirty, the bytes are made and written later (about 1 s after the last change, 3 s at most while changes keep coming), several changes to one file become one write, files are written in the order they were changed, and everything pending is written at quit. Durable records (a chat's record, the orchestration journal) do not go through here: their callers wait for the disk.

/** A change is written this long after the last one. */
const IDLE_MS = 1000;
/** ...but never later than this after the first unwritten one, so a stream of changes still reaches the disk. */
const MAX_MS = 3000;
/** A write that keeps failing is tried again after twice the wait each time, up to this. */
const RETRY_CAP_MS = 60_000;
/** After this many failures in a row the owner is told once (a persistent failure is shown to the user). */
const FAILURES_BEFORE_NOTICE = 5;
/** What a producer returns to delete the file instead of writing it. */
const REMOVE = Symbol('remove');

/**
 * @typedef {{ file: string, produce: () => string | Buffer | symbol | null, written: (() => void) | undefined, mode: number | undefined,
 *   dirty: boolean, firstAt: number, timer: any, inflight: Promise<void> | null, epoch: number, seq: number, fails: number,
 *   told: boolean }} Entry
 */

class WriteBehind {
  /**
   * Everything that touches the disk or the clock is handed in, so the writer imports nothing.
   * @param {{ writeAsync: (file: string, data: string | Buffer, stillCurrent: () => boolean, mode?: number) => Promise<boolean>,
   *   writeSync: (file: string, data: string | Buffer, fs: any, mode?: number) => void, remove: (file: string) => void,
   *   fs: any, note: (what: string, error: unknown) => void, failed: (file: string, error: unknown) => void,
   *   now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, onFirstWrite?: () => void,
   *   idleMs?: number, maxMs?: number }} o
   *   failed: called once when a file has failed FAILURES_BEFORE_NOTICE writes in a row, or cannot be made at all
   */
  constructor(o) {
    this.o = o;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.maxMs = o.maxMs ?? MAX_MS;
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? setTimeout;
    this.clearTimer = o.clearTimer ?? clearTimeout;
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    this.seq = 0;
    this.started = false;
  }

  /**
   * The file's content is now whatever `produce` returns at write time (a string or buffer; REMOVE deletes the file; null
   * writes nothing). Later calls for the same file replace the producer.
   * `written` runs after each write that reached the disk. `mode`: permission bits of the file when it is new.
   * @param {string} file @param {Entry['produce']} produce @param {() => void} [written] @param {number} [mode]
   */
  set(file, produce, written, mode) {
    if (!this.started) {
      this.started = true;
      this.o.onFirstWrite?.();
    }
    let e = this.entries.get(file);
    if (!e) {
      e = { file, produce, written, mode, dirty: false, firstAt: 0, timer: null, inflight: null, epoch: 0, seq: 0, fails: 0, told: false };
      this.entries.set(file, e);
    }
    e.produce = produce;
    e.written = written;
    e.mode = mode;
    e.seq = ++this.seq;
    if (!e.dirty) {
      e.dirty = true;
      e.firstAt = this.now();
    }
    this.arm(e, Math.max(0, Math.min(this.idleMs, e.firstAt + this.maxMs - this.now())));
  }

  /** Whether the file has a change not yet on the disk. */
  pending(/** @type {string} */ file) {
    const e = this.entries.get(file);
    return !!e && (e.dirty || e.inflight !== null);
  }

  /** Forget the file's unwritten change (its owner deleted it). */
  cancel(/** @type {string} */ file) {
    const e = this.entries.get(file);
    if (!e) return;
    if (e.timer) this.clearTimer(e.timer);
    // a write on its way must not publish after the deletion
    e.epoch++;
    this.entries.delete(file);
  }

  /** @param {Entry} e @param {number} wait */
  arm(e, wait) {
    if (e.timer) this.clearTimer(e.timer);
    e.timer = this.setTimer(() => {
      e.timer = null;
      this.writeNow(e);
    }, wait);
    e.timer?.unref?.();
  }

  /** @param {Entry} e */
  writeNow(e) {
    const file = e.file;
    if (e.inflight || !e.dirty) return;
    const epoch = e.epoch;
    let data;
    try {
      data = e.produce();
    } catch (error) {
      this.cannotMake(file, e, error);
      return;
    }
    e.dirty = false;
    if (data === null) return;
    if (data === REMOVE) {
      try {
        this.o.remove(file);
        this.succeeded(e);
      } catch (error) {
        this.failed(file, e, error);
      }
      return;
    }
    e.inflight = this.o
      .writeAsync(file, /** @type {string | Buffer} */ (data), () => e.epoch === epoch, e.mode)
      .catch((error) => (this.failed(file, e, error), false))
      .then((published) => {
        e.inflight = null;
        if (published) this.succeeded(e);
        // changed while it was being written: the next write follows after the usual wait
        if (e.dirty && !e.timer && this.entries.get(file) === e) {
          e.firstAt = this.now();
          this.arm(e, this.idleMs);
        }
      });
  }

  /** @param {Entry} e */
  succeeded(e) {
    e.fails = 0;
    e.told = false;
    e.written?.();
  }

  /** The content cannot be made: that does not change by waiting, so it is told once and not tried again. */
  cannotMake(/** @type {string} */ file, /** @type {Entry} */ e, /** @type {unknown} */ error) {
    this.o.note(`make ${file}`, error);
    e.dirty = false;
    this.tell(file, e, error);
  }

  /** A write that failed is tried again after twice the wait each time (capped), and the owner is told once it persists. */
  failed(/** @type {string} */ file, /** @type {Entry} */ e, /** @type {unknown} */ error) {
    this.o.note(`save ${file}`, error);
    e.dirty = true;
    e.fails++;
    if (e.fails >= FAILURES_BEFORE_NOTICE) this.tell(file, e, error);
    if (!e.timer && this.entries.get(file) === e) {
      e.firstAt = this.now();
      this.arm(e, Math.min(this.maxMs * 2 ** (e.fails - 1), RETRY_CAP_MS));
    }
  }

  tell(/** @type {string} */ file, /** @type {Entry} */ e, /** @type {unknown} */ error) {
    if (e.told) return;
    e.told = true;
    try {
      this.o.failed(file, error);
    } catch (inner) {
      this.o.note('tell that a file could not be saved', inner);
    }
  }

  /** Write everything pending now, in this thread, in the order it was changed (quit, or before something reads the files). */
  flushSync() {
    const due = [...this.entries].filter(([, e]) => e.dirty || e.inflight).sort(([, a], [, b]) => a.seq - b.seq);
    for (const [file, e] of due) this.flushEntry(file, e);
  }

  /** Flush one pending file and return whether its current bytes reached disk. */
  flushFile(/** @type {string} */ file, /** @type {typeof this.o.writeSync} */ write = this.o.writeSync) {
    const e = this.entries.get(file);
    return !!e && this.flushEntry(file, e, write);
  }

  /** @param {string} file @param {Entry} e */
  flushEntry(file, e, write = this.o.writeSync) {
    if (e.timer) this.clearTimer(e.timer);
    e.timer = null;
    // a write already started may finish after this one: it must not publish its older bytes
    e.epoch++;
    let data;
    try {
      data = e.produce();
    } catch (error) {
      this.cannotMake(file, e, error);
      return false;
    }
    try {
      if (data === REMOVE) this.o.remove(file);
      else if (data !== null) write(file, /** @type {string | Buffer} */ (data), this.o.fs, e.mode);
      e.dirty = false;
      if (data !== null) this.succeeded(e);
      return data !== null;
    } catch (error) {
      this.o.note(`save ${file}`, error);
      e.dirty = true;
      e.fails++;
      if (e.fails >= FAILURES_BEFORE_NOTICE) this.tell(file, e, error);
      return false;
    }
  }

  /** Write everything pending and wait until the writes started have finished. */
  async flush() {
    this.flushSync();
    await Promise.all([...this.entries.values()].map((e) => e.inflight));
  }
}

module.exports = { WriteBehind, REMOVE, IDLE_MS, MAX_MS, RETRY_CAP_MS, FAILURES_BEFORE_NOTICE };

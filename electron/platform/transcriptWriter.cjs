// Appends JSON-lines logs off the main loop, through the Rust core's transcript crate: one queue per file, written in batches, read back with the lines not on disk yet.
//
// A harness streams hundreds of records a second; writing each with appendFileSync stalls the main process every window
// shares (docs/performance/design.md, D2). A file's first line is written at once (so the file exists, and listings and
// existence checks see it), later lines wait up to `flushMs` and go out in one append per file, never two at a time for
// one file. `readText()` returns what the file holds plus what is still queued, without blocking main.
//
// The state is per file path in one writer: app/sessions.cjs makes the app's one writer (docs/architecture/modularization.md
// §3), so every log over the same folder sees the same pending lines.
const { core, coreEvents, requiredCore } = require('./core.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { probing, recordWrite } = require('../perf/probe.cjs');

/** How long a line may wait before its file is written. */
const FLUSH_MS = 250;
/** A queue this large is written now rather than at the next tick. */
const SOON_BYTES = 1 << 20;
/** How long lines are written synchronously after a drain; a quit takes far less (QUIT_CLEANUP_MS holds it at most). */
const SYNC_AFTER_DRAIN_MS = 30_000;
/** While a file's writes fail, its queue keeps at most this much; older lines past it are dropped and reported. */
const MAX_PENDING_BYTES = 16 << 20;

/** The writers the core's events are for, by id. @type {Map<number, WeakRef<TranscriptWriter>>} */
const writers = new Map();

/** A writer that is collected closes in the core, which writes what it has queued. */
const closeInCore = new FinalizationRegistry((/** @type {{ addon: any, id: number }} */ held) => {
  writers.delete(held.id);
  try {
    held.addon.dispatchSync('transcript.close', Buffer.from(JSON.stringify({ id: held.id })));
  } catch (error) {
    noteIgnored('close a transcript writer', error);
  }
});

/** What the core says of its writers. @param {Buffer} event */
function heard(event) {
  // events of other domains share the stream
  if (!event.subarray(0, 14).equals(Buffer.from('{"transcript":'))) return;
  const { transcript: id, failed, wrote } = JSON.parse(String(event));
  if (wrote) recordWrite(wrote);
  if (failed) writers.get(id)?.deref()?.failed(failed);
}

const heardBy = new WeakSet();

/** The error a read failed with, carrying the code callers tell a missing file by. @param {unknown} error */
function coded(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(message), /(ENOENT|os error 2\))/.test(message) ? { code: 'ENOENT' } : {});
}

class TranscriptWriter {
  /**
   * @param {object} [o]
   * @param {number} [o.flushMs]
   * @param {number} [o.soonBytes]
   * @param {number} [o.maxPendingBytes]
   * @param {(file: string, error: unknown) => void} [o.onError] a write failed, or lines were dropped (once until a write succeeds)
   * @param {import('./core.cjs').CoreAddon | null} [o.addon] the Rust core (default: the one loaded)
   */
  constructor(o = {}) {
    // no core is the error every core call throws: nothing else can write a transcript
    const { addon = core() } = o;
    this.addon = requiredCore(addon);
    /** @type {Set<(file: string, error: unknown) => void>} */
    this.errorListeners = new Set(o.onError ? [o.onError] : []);
    const asked = {
      flushMs: o.flushMs ?? FLUSH_MS,
      soonBytes: o.soonBytes ?? SOON_BYTES,
      maxPendingBytes: o.maxPendingBytes ?? MAX_PENDING_BYTES,
    };
    this.id = Number(String(this.call('transcript.open', asked)));
    writers.set(this.id, new WeakRef(this));
    closeInCore.register(this, { addon: this.addon, id: this.id });
    if (!heardBy.has(this.addon)) {
      heardBy.add(this.addon);
      coreEvents(heard, this.addon);
    }
  }

  /** The reply of synchronous `route`. @param {string} route @param {object} ask */
  call(route, ask) {
    return this.addon.dispatchSync(route, Buffer.from(JSON.stringify(ask)));
  }

  /** @param {{ file: string, what: string, message: string }} failure */
  failed({ file, what, message }) {
    const error = new Error(message);
    noteIgnored(what, error);
    for (const fn of this.errorListeners) {
      try {
        fn(file, error);
      } catch (e) {
        // one listener's failure must not stop the others, nor the writer
        noteIgnored('report a transcript write failure', e);
      }
    }
  }

  /** @param {(file: string, error: unknown) => void} fn */
  onError(fn) {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  /**
   * Queue lines (each must end in a newline) for `file`. The first lines for a file this process has not written yet go out
   * at once, so the file exists from the first record.
   * @param {string} file
   * @param {string[]} lines
   * @param {{ mode?: number, what?: string, chat?: string }} [opts] permissions for a file this creates; what a failure is
   *   recorded as; the chat the performance probe names its writes by (the file's name by default)
   */
  append(file, lines, opts = {}) {
    if (!lines.length) return;
    const header = {
      id: this.id,
      file,
      mode: opts.mode ?? null,
      what: opts.what ?? 'write a log file',
      chat: opts.chat ?? file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1),
      timed: probing(),
    };
    try {
      this.addon.dispatchSync('transcript.append', Buffer.from(`${JSON.stringify(header)}\n${lines.join('')}`));
    } catch (error) {
      this.failed({ file, what: header.what, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves with the core's reply on another thread. @param {string} route @param {object} ask */
  async later(route, ask) {
    return this.addon.dispatch(route, Buffer.from(JSON.stringify(ask)));
  }

  /**
   * Start writing `file`'s queued lines now. Resolves once every line queued before this call is on disk (or its write failed
   * and was reported; the lines stay queued for the next tick).
   * @param {string} file
   * @returns {Promise<void>}
   */
  async flush(file) {
    await this.later('transcript.flush', { id: this.id, file });
  }

  /**
   * Write everything queued and wait for it; for the next `syncMs` lines are written as they come (the app is quitting). A
   * quit that does not happen after all (one a later handler holds) ends that, so lines are batched again.
   * @param {number} [syncMs]
   */
  async drain(syncMs = SYNC_AFTER_DRAIN_MS) {
    await this.later('transcript.drain', { id: this.id, syncMs });
  }

  /**
   * The file's text with its pending lines after it, as it will read once they are written, without blocking the main process.
   * Throws what reading the file throws, except a missing file with pending lines.
   * @param {string} file
   * @returns {Promise<string>}
   */
  async readText(file) {
    try {
      return String(await this.later('transcript.read', { id: this.id, file }));
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * What a list or a search wants of a file, with its pending lines, read and sifted off the main process. Throws as
   * readText does.
   * @param {string} file @param {{ kinds?: string[], needle?: string }} o
   * @returns {Promise<{ records: any[], torn: number, found: boolean }>}
   */
  async scan(file, o) {
    try {
      return JSON.parse(String(await this.later('transcript.scan', { id: this.id, file, ...o })));
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * The recordings `files` name, with their pending lines. Rejects when one can't be read, so that no recording goes for want of a read.
   * @param {string[]} files
   * @returns {Promise<string[]>} file names
   */
  async audioRefs(files) {
    return JSON.parse(String(await this.later('transcript.audioRefs', { id: this.id, files })));
  }

  /** Whether the file exists or has pending lines. @param {string} file */
  has(file) {
    return String(this.call('transcript.has', { id: this.id, file })) === 'true';
  }

  /** How many bytes for `file` are not on disk yet. @param {string} file */
  pending(file) {
    return Number(String(this.call('transcript.pending', { id: this.id, file })));
  }

  /** Remove the file: queued lines are dropped, a running write removes it as it ends, and later lines are ignored. @param {string} file */
  remove(file) {
    this.call('transcript.remove', { id: this.id, file });
  }
}

/** The writer every transcript in this process goes through. */
module.exports = { TranscriptWriter, FLUSH_MS, SOON_BYTES, MAX_PENDING_BYTES, SYNC_AFTER_DRAIN_MS };

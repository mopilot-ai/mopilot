// One stream's JSON lines, in order: the Rust core frames them and they are parsed here, on the thread their values live on,
// in slices that keep main responsive. The core frames a child's stdout on its own thread when the spawn asks for `lines`
// (electron/platform/coreChild.cjs); any other stream's bytes go through its framing routes (electron/platform/coreFraming.cjs).
const { TOO_LONG, openFramer } = require('../platform/coreFraming.cjs');

/** Queued line bytes at which the stream is paused, and below which it resumes. */
const HIGH_BYTES = 2 * 1024 * 1024;
const LOW_BYTES = 512 * 1024;
/** The longest a slice of deliveries runs before main gets a turn. */
const DISPATCH_MS = 4;

/**
 * What a framed stream says on 'data': the lines one read ended, and whether a line past the limit came after them.
 * @typedef {{ lines: Buffer[], tooLong: boolean }} Framed
 */

class JsonReader {
  /**
   * @param {{ onValue: (value: any) => void, onError: (error: Error) => void, onInvalid?: (error: Error, line: string) => void,
   * stream?: any, maxUnits?: number, open?: typeof openFramer, schedule?: typeof setImmediate,
   * cancel?: typeof clearImmediate, clock?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.closed = false;
    /** The stream ended: what is queued is the last of it. */
    this.sealed = false;
    /** A line past the limit was framed: its failure is queued behind the lines before it, and nothing after is read. */
    this.overflowed = false;
    /** @type {(Buffer | Error)[]} lines to deliver, and the failure that follows them if one does */
    this.queue = [];
    this.bytes = 0;
    this.paused = false;
    this.draining = false;
    /** @type {ReturnType<typeof setImmediate> | null} */
    this.dispatch = null;
    /** @type {(() => void)[]} what waits for the queue to be delivered */
    this.waiting = [];
    /** @type {ReturnType<typeof openFramer> | null} the core's framer, for a stream of bytes */
    this.framer = null;
    /** The first half of a surrogate pair a text chunk ended with, for the next. */
    this.carry = '';
    this.schedule = o.schedule ?? setImmediate;
    this.cancel = o.cancel ?? clearImmediate;
    this.clock = o.clock ?? (() => performance.now());
  }

  /**
   * A chunk of the stream: its bytes, its decoded text, or the lines a core child's framed stdout already cut.
   * @param {Uint8Array | string | Framed} chunk
   */
  push(chunk) {
    if (this.closed || this.sealed || this.overflowed) return;
    try {
      const framed = typeof chunk === 'string' ? this.frame(this.bytesOf(chunk)) : chunk instanceof Uint8Array ? this.frame(chunk) : chunk;
      if (!Array.isArray(framed?.lines)) throw new TypeError('JSON input comes as bytes, text, or the lines the core framed');
      for (const line of framed.lines) {
        this.queue.push(line);
        this.bytes += line.length;
      }
      if (framed.tooLong) {
        // the core let its framer go: the stream's input ends here, though the lines before are still delivered
        this.overflowed = true;
        this.queue.push(new RangeError(TOO_LONG));
      }
      if (!this.paused && this.bytes >= HIGH_BYTES) {
        this.paused = true;
        this.o.stream?.pause?.();
      }
      // a value's handler that pushes adds to the slice under way
      if (this.dispatch === null && !this.draining) this.slice();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Text as UTF-8, a surrogate pair split between chunks made whole first. @param {string} text */
  bytesOf(text) {
    const whole = this.carry + text;
    const last = whole.charCodeAt(whole.length - 1);
    const cut = last >= 0xd800 && last <= 0xdbff ? whole.length - 1 : whole.length;
    this.carry = whole.slice(cut);
    return Buffer.from(whole.slice(0, cut));
  }

  /** @param {Uint8Array} bytes */
  frame(bytes) {
    this.framer ??= (this.o.open ?? openFramer)(this.o.maxUnits);
    return this.framer.push(/** @type {Buffer} */ (bytes));
  }

  /** Deliver what is queued, in order, until the budget is spent; the rest waits for main's next turn. */
  slice() {
    this.dispatch = null;
    this.draining = true;
    // the clock is read only when there is more than one line to deliver: a streamed delta comes one line a read
    const started = this.queue.length > 1 ? this.clock() : -Infinity;
    try {
      while (!this.closed && this.queue.length) {
        const item = /** @type {Buffer | Error} */ (this.queue.shift());
        if (item instanceof Error) throw item;
        this.bytes -= item.length;
        this.deliver(item);
        if (this.queue.length && this.clock() - started >= DISPATCH_MS) break;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.draining = false;
    }
    if (this.closed) return;
    if (this.paused && this.bytes <= LOW_BYTES) {
      this.paused = false;
      this.o.stream?.resume?.();
    }
    if (this.queue.length) this.dispatch = this.schedule(() => this.slice());
    else if (this.sealed) this.close();
  }

  /** One line: blank is nothing, and a line that isn't JSON is told apart. @param {Buffer} line */
  deliver(line) {
    const text = line.toString('utf8');
    if (!text.trim()) return;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      this.o.onInvalid?.(new SyntaxError('Invalid JSON'), text);
      return;
    }
    this.o.onValue(value);
  }

  /**
   * `done` once every line of the stream is delivered. A child's exit can come before the last of its stdout: the stream's
   * end, not the exit, seals the reader. A line still arriving at the end is no line.
   * @param {() => void} done
   */
  finishInput(done) {
    const stream = this.o.stream;
    if (!this.closed && stream?.readable && !stream.readableEnded && !stream.destroyed) {
      const finish = () => {
        stream.off('end', finish);
        stream.off('close', finish);
        this.finishInput(done);
      };
      stream.once('end', finish);
      stream.once('close', finish);
      return;
    }
    if (this.closed || !this.queue.length) {
      this.close();
      done();
      return;
    }
    this.sealed = true;
    this.waiting.push(done);
  }

  /** @param {unknown} error */
  fail(error) {
    if (this.closed) return;
    this.close();
    this.o.onError(error instanceof Error ? error : new Error(String(error)));
  }

  /** Stop: nothing queued is delivered, and the core's framer goes. What waits on `finishInput` is told. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.bytes = 0;
    if (this.dispatch !== null) this.cancel(this.dispatch);
    this.dispatch = null;
    this.framer?.close();
    this.framer = null;
    for (const done of this.waiting.splice(0)) queueMicrotask(done);
  }
}

module.exports = { JsonReader, HIGH_BYTES, LOW_BYTES, DISPATCH_MS };

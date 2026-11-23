// A harness child the Rust core owns (core/crates/proc/src/spawn.rs), in a ChildProcess's shape: pid, stdin, stdout and
// stderr streams, exit, close and error events, and the fields killTree and endGroup read (electron/platform/winbin.cjs),
// so nothing above this file knows who holds the pipes. The core reads and writes them on threads of its own; this file
// turns its events back into streams and tells it what was taken, which is all that holds a child's output back.
//
// There is no other way to start one: without the core, a child fails as one that could not be spawned, with the core's
// problem as its error. With `lines`, the core frames stdout too: it comes as the complete lines each read ended, not bytes.
const { channel } = require('node:diagnostics_channel');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');
const { getSystemErrorMap, getSystemErrorName, inspect } = require('node:util');
const { core, coreEvents, coreProblem } = require('./core.cjs');
const { MOST_UNITS, framedLines } = require('./coreFraming.cjs');
const { WINDOWS_ERRORS } = require('./windowsErrors.cjs');

/** The first byte of a child's event, and the header's size: [mark, kind, id as 6 bytes little-endian]. */
const MARK = 1;
const HEADER = 8;
const ID_BYTES = 6;
/** What each event is (core/crates/proc/src/spawn.rs): an output's bytes are its index, its end that past OUTPUT_END, and the last is the child's close. */
const OUTPUT_END = 2;
const EXIT = 4;
const INPUT_FAILED = 5;
const INPUT_DRAINED = 6;
const LINES = 8;
const ASK = 9;
/** What `proc.write` replies. */
const FULL = 1;
const GONE = 2;

/** The spawn failures that Node reports as an 'error' event; any other it throws. */
const REPORTED = new Set(['EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOENT']);
/** Long enough never to fire: all it does is keep this process's event loop open, as a ChildProcess's handle does. */
const FOREVER_MS = 2 ** 31 - 1;

/** Where a spawn is announced for the performance probe (electron/perf/probe.cjs), as Node announces its own. */
const spawns = channel('child_process');

/** A system error's name, as Node would give it. @param {number} errno @param {string} [platform] */
function errorName(errno, platform = process.platform) {
  if (platform !== 'win32') return getSystemErrorName(-errno);
  return WINDOWS_ERRORS[/** @type {keyof typeof WINDOWS_ERRORS} */ (errno)] ?? 'UNKNOWN';
}

/** libuv's number for each error name: what Node gives as `errno`, which on Windows is neither the system's number nor its negative. */
const LIBUV_NUMBERS = new Map([...getSystemErrorMap()].map(([number, [name]]) => [name, number]));

/** What a system error looks like from Node's child_process: `syscall code`, with its fields. @param {string} syscall @param {string} code */
function systemError(syscall, code) {
  return Object.assign(new Error(`${syscall} ${code}`), { errno: LIBUV_NUMBERS.get(code), code, syscall });
}

/** The name of signal number `signal`, or null. @param {number | null} signal */
function signalName(signal) {
  const found = Object.entries(os.constants.signals).find(([, number]) => number === signal);
  return found ? found[0] : null;
}

/** The children each addon's events are for, by id. @type {WeakMap<object, Map<number, CoreChild>>} */
const live = new WeakMap();

/** `addon`'s live children, listening to its stream the first time. @param {import('./core.cjs').CoreAddon} addon */
function childrenOf(addon) {
  let children = live.get(addon);
  if (!children) {
    const all = (children = new Map());
    coreEvents((/** @type {Buffer} */ event) => {
      // events of other domains share the stream
      if (event[0] !== MARK) return;
      try {
        all.get(event.readUIntLE(2, ID_BYTES))?.heard(event[1], event.subarray(HEADER));
      } catch (error) {
        // a child's listener threw: core.cjs would note it, and from a ChildProcess it reaches uncaughtException
        process.nextTick(() => {
          throw error;
        });
      }
    }, addon);
    live.set(addon, all);
  }
  return children;
}

/** A string as Node's spawn would pass it: lone surrogates, which JSON can't carry, as U+FFFD. @param {unknown} value */
const wellFormed = (value) => /** @type {any} */ (String(value)).toWellFormed();

/** Throws as Node's spawn does for a string no process can be given. @param {string} name @param {string} value */
function refuseNul(name, value) {
  if (value.includes('\0'))
    throw Object.assign(new TypeError(`The argument '${name}' must be a string without null bytes. Received ${inspect(value)}`), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
}

/** The variables Node's spawn passes: on Windows, where a name has no case, the first of each name in sorted order. @param {Record<string, string | undefined>} env @param {string} platform */
function variables(env, platform) {
  if (platform !== 'win32') return Object.entries(env);
  const seen = new Set();
  return Object.entries(env)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .filter(([name]) => !seen.has(name.toUpperCase()) && seen.add(name.toUpperCase()));
}

/**
 * What the core starts, from spawn's arguments. As Node's: a variable set to undefined is unset, and the rest are strings.
 * @param {string} command @param {readonly string[]} args @param {CoreSpawnOptions} options @param {string} [platform]
 */
function specOf(command, args, options, platform = process.platform) {
  const [stdin, stdout, stderr] = options.stdio ?? [];
  if (stdin !== 'pipe' || stdout !== 'pipe' || (stderr !== 'pipe' && stderr !== 'ignore'))
    throw new TypeError('A child the core owns has pipes for stdin and stdout, and a pipe or nothing for stderr');
  const env = variables(options.env ?? process.env, platform)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [wellFormed(name), wellFormed(value)]);
  const spec = {
    command: wellFormed(command),
    args: args.map(wellFormed),
    // an empty one is none, as Node has it
    cwd: options.cwd ? wellFormed(options.cwd) : null,
    env,
    stderr: stderr === 'pipe',
    group: options.detached === true,
    hide: options.windowsHide === true,
    verbatim: options.windowsVerbatimArguments === true,
    // with no limit of its own, a line is as long as a JS string can be, which is what reading it ever allowed
    lines: options.lines ? { limit: Number.isFinite(options.lines.maxUnits) ? options.lines.maxUnits : MOST_UNITS } : null,
  };
  refuseNul('file', spec.command);
  spec.args.forEach((arg, i) => refuseNul(`args[${i}]`, arg));
  for (const [name, value] of env) refuseNul(`options.env['${name}']`, `${name}=${value}`);
  return spec;
}

/**
 * One output: a Readable the child's events are pushed into, telling the core what it took. A framed stdout is in object
 * mode, and each chunk is the lines one read ended (`framedLines`).
 */
class Output extends Readable {
  /**
   * @param {(amount: number) => void} ack @param {{ cost: number, ack: number }} terms what the core charges, and how often it hears
   * @param {boolean} [framed]
   */
  constructor(ack, terms, framed = false) {
    // a framed chunk can be a whole record, so one waiting is enough to stop acknowledging: the core holds the rest
    super(framed ? { objectMode: true, highWaterMark: 1 } : {});
    this.ack = ack;
    this.terms = terms;
    this.owed = 0;
    this.holding = false;
    /** A framed stdout: whether it was read since its last chunk, and the ask the core waits to hear is wanted, if one. */
    this.demand = false;
    /** @type {number | null} */
    this.asking = null;
    /** @type {((ask: number) => void) | null} tells the core this stream wants the line ask `ask` was about, however long */
    this.want = null;
    /** @type {(() => void) | null} tells the core this stream is gone: what comes is dropped, no line kept */
    this.dropLines = null;
  }

  /**
   * A chunk from the core, of `size` bytes as it charged them. Past what the stream takes, nothing is acknowledged: the core
   * stops, and in time so does the child.
   * @param {Buffer | ReturnType<typeof framedLines>} chunk @param {number} size
   */
  received(chunk, size) {
    // what was asked about came, or was cut off by what came: an ask after this is a new one
    this.demand = false;
    this.asking = null;
    this.owed += size + this.terms.cost;
    // what a destroyed stream can't take is taken all the same, so the core's reader stops for nothing
    if (this.destroyed) this.settle();
    else if (!this.push(chunk)) this.holding = true;
    else if (this.owed >= this.terms.ack) this.settle();
  }

  settle() {
    if (this.owed === 0) return;
    this.ack(this.owed);
    this.owed = 0;
  }

  /** Whatever it held goes too: nothing will read it, and the core must not wait for that. @param {Error | null} error @param {(error?: Error | null) => void} done */
  _destroy(error, done) {
    this.holding = false;
    this.settle();
    this.dropLines?.();
    done(error);
  }

  /**
   * The core's line still arriving fills the window (ask `ask`): it goes on once this stream is read, or at once if it is.
   * A destroyed stream told the core to drop it all.
   * @param {number} ask
   */
  ask(ask) {
    if (this.destroyed) return;
    if (this.demand) this.want?.(ask);
    else this.asking = ask;
  }

  _read() {
    this.demand = true;
    if (this.asking !== null) {
      const ask = this.asking;
      this.asking = null;
      this.want?.(ask);
    }
    if (!this.holding) return;
    this.holding = false;
    this.settle();
  }
}

/** Stdin: a Writable whose bytes the core queues. Past its queue a write stays here, unfinished, as on a full socket. */
class Input extends Writable {
  /** @param {CoreChild} child */
  constructor(child) {
    super({ decodeStrings: true });
    this.child = child;
    /** @type {((error?: Error | null) => void) | null} the write held until the core has room */
    this.held = null;
  }

  /** @param {Buffer} chunk @param {BufferEncoding} _encoding @param {(error?: Error | null) => void} done */
  _write(chunk, _encoding, done) {
    const reply = this.child.call('proc.write', Buffer.concat([Buffer.from(`${this.child.id}\n`), chunk]));
    const written = reply[0] - 48;
    if (written === GONE) done(systemError('write', 'EPIPE'));
    else if (written === FULL) this.held = done;
    else done();
  }

  /** @param {(error?: Error | null) => void} done */
  _final(done) {
    this.child.call('proc.endInput', Buffer.from(String(this.child.id)));
    done();
  }

  /**
   * Nothing more goes in, and a write held here fails. Unless this is the end of a stream that finished, when the core still
   * has what it queued to write, the child's read ends now with what is queued dropped, as on a closed socket.
   * @param {Error | null} error @param {(error?: Error | null) => void} done
   */
  _destroy(error, done) {
    const held = this.held;
    this.held = null;
    held?.(error ?? Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
    if (this.child.pid !== undefined && !this.writableFinished) this.child.call('proc.closeInput', Buffer.from(String(this.child.id)));
    done(error);
  }

  /** The core has room again. */
  drained() {
    const done = this.held;
    this.held = null;
    done?.();
  }
}

/**
 * The options a child takes: spawn's, as spawnArgs leaves them, and `lines` for a stdout the core frames, with the longest
 * line in UTF-16 units (none when not finite). A spawn by Node ignores it.
 * @typedef {{ cwd?: string | null, env?: Record<string, string | undefined>, stdio?: readonly string[], detached?: boolean, windowsHide?: boolean, windowsVerbatimArguments?: boolean, lines?: { maxUnits?: number } }} CoreSpawnOptions
 */

class CoreChild extends EventEmitter {
  /**
   * @param {import('./core.cjs').CoreAddon | null} addon
   * @param {string} command @param {readonly string[]} args @param {CoreSpawnOptions} options
   */
  constructor(addon, command, args, options) {
    super();
    const spec = specOf(command, args, options);
    this.addon = addon;
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    /** @type {number | undefined} */
    this.pid = undefined;
    /** @type {number} the core's handle */
    this.id = 0;
    /** @type {number | null} */
    this.exitCode = null;
    /** @type {NodeJS.Signals | null} */
    this.signalCode = null;
    this.killed = false;
    /** @type {Promise<boolean> | undefined} on Windows, whether its tree is in a Job Object (winbin.cjs spawnGroup) */
    this.held = undefined;
    /** What the core charges for output, from its reply. */
    this.terms = { cost: 0, ack: Number.MAX_SAFE_INTEGER };
    /** @type {NodeJS.Timeout | null} */
    this.alive = null;
    this.stdin = new Input(this);
    const output = (/** @type {number} */ which) =>
      new Output((amount) => this.acknowledge(which, amount), this.terms, which === 0 && spec.lines !== null);
    this.stdout = output(0);
    if (spec.lines) {
      this.stdout.want = (ask) => this.call('proc.want', Buffer.from(`${this.id} ${ask}`));
      // a child that never started has nothing to drop
      this.stdout.dropLines = () => this.pid !== undefined && this.call('proc.drop', Buffer.from(String(this.id)));
    }
    this.stderr = spec.stderr ? output(1) : null;
    /** The streams the core's events name. */
    this.outputs = this.stderr ? [this.stdout, this.stderr] : [this.stdout];
    this.closes = 0;
    /** The exit, then stdin and each output. */
    this.needed = 2 + this.outputs.length;
    for (const stream of [this.stdin, ...this.outputs]) stream.once('close', () => this.closedOne());
    spawns.publish({ process: this });
    this.start(spec);
  }

  /** The reply of synchronous `route`. @param {string} route @param {Buffer} payload @returns {Buffer} */
  call(route, payload) {
    return /** @type {NonNullable<import('./core.cjs').CoreAddon['dispatchSync']>} */ (
      /** @type {import('./core.cjs').CoreAddon} */ (this.addon).dispatchSync
    )(route, payload);
  }

  /** @param {number} which @param {number} amount */
  acknowledge(which, amount) {
    this.call('proc.ack', Buffer.from(`${this.id} ${which} ${amount}`));
  }

  /** @param {ReturnType<typeof specOf>} spec */
  start(spec) {
    const addon = this.addon;
    if (!addon) return this.failed(new Error(coreProblem() ?? 'The Rust core is missing, and it runs every harness process.'));
    let reply;
    try {
      const children = childrenOf(addon);
      reply = JSON.parse(String(this.call('proc.spawn', Buffer.from(JSON.stringify(spec)))));
      if (reply.errno === undefined) {
        this.pid = reply.pid;
        this.id = reply.id;
        this.terms.cost = reply.cost;
        this.terms.ack = reply.ack;
        this.held = Promise.resolve(reply.held);
        this.alive = setInterval(/** @type {() => void} */ (Function.prototype), FOREVER_MS);
        children.set(this.id, this);
        process.nextTick(() => this.emit('spawn'));
        return;
      }
    } catch (error) {
      // a core that refused (too many children, one built before this route) says why
      return this.failed(/** @type {Error} */ (error));
    }
    if (reply.errno === null) return this.failed(new Error(reply.message));
    const code = errorName(reply.errno);
    if (!REPORTED.has(code)) throw systemError('spawn', code);
    const error = systemError(`spawn ${this.spawnfile}`, code);
    this.failed(Object.assign(error, { path: this.spawnfile, spawnargs: this.spawnargs.slice(1) }), error.errno);
  }

  /** No process came of this: 'error' on the next tick, as from Node, and a close but no exit. @param {Error} error @param {number} [code] */
  failed(error, code = -1) {
    process.nextTick(() => {
      this.exitCode = code;
      this.stdin.destroy();
      try {
        this.emit('error', error);
      } finally {
        for (const stream of this.outputs) stream.push(null);
        this.flush();
        this.closedOne();
      }
    });
  }

  /** Nothing else reads what is left once a child has gone, unless someone reads it by hand. */
  flush() {
    for (const stream of this.outputs) if (stream.readable && !stream.listenerCount('readable')) stream.resume();
  }

  /** One of the streams closed, or the child exited. */
  closedOne() {
    if (++this.closes === this.needed) this.emit('close', this.exitCode, this.signalCode);
  }

  /** An event of the core's. @param {number} kind @param {Buffer} bytes */
  heard(kind, bytes) {
    if (kind < OUTPUT_END) this.outputs[kind].received(bytes, bytes.length);
    else if (kind === LINES) this.stdout.received(framedLines(bytes), bytes.length);
    else if (kind === ASK) this.stdout.ask(Number(bytes.readBigUInt64LE(0)));
    else if (kind < EXIT) this.outputs[kind - OUTPUT_END].push(null);
    else if (kind === EXIT) this.exited(JSON.parse(String(bytes)));
    else if (kind === INPUT_FAILED) this.inputFailed(JSON.parse(String(bytes)));
    else if (kind === INPUT_DRAINED) this.stdin.drained();
    else this.gone();
  }

  /** @param {[number | null, number | null]} status */
  exited([code, signal]) {
    this.exitCode = code;
    this.signalCode = /** @type {NodeJS.Signals | null} */ (signalName(signal));
    this.stdin.destroy();
    try {
      this.emit('exit', this.exitCode, this.signalCode);
    } finally {
      process.nextTick(() => this.flush());
      this.closedOne();
    }
  }

  /** @param {[number | null, string]} failure */
  inputFailed([errno, message]) {
    this.stdin.destroy(errno === null ? new Error(message) : systemError('write', errorName(errno)));
  }

  /** The core's last word on this child: exit told, outputs ended, handle removed. */
  gone() {
    clearInterval(/** @type {NodeJS.Timeout} */ (this.alive));
    childrenOf(/** @type {import('./core.cjs').CoreAddon} */ (this.addon)).delete(this.id);
  }

  /**
   * Signal the child: whether it went, false once it has been reaped. The whole tree is killTree's.
   * @param {NodeJS.Signals | number} [signal]
   */
  kill(signal = 'SIGTERM') {
    const number = typeof signal === 'number' ? signal : os.constants.signals[signal];
    if (number === undefined) throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: 'ERR_UNKNOWN_SIGNAL' });
    if (this.pid === undefined) return false;
    const sent = String(this.call('proc.signal', Buffer.from(`${this.id} ${number}`))) === 'true';
    this.killed ||= sent;
    return sent;
  }
}

/**
 * spawn's shape, for spawnGroup: a child the core owns.
 * @param {string} command @param {readonly string[]} [args] @param {CoreSpawnOptions} [options]
 * @param {import('./core.cjs').CoreAddon | null} [addon]
 */
function spawnCore(command, args = [], options = {}, addon = core()) {
  return new CoreChild(addon, command, args, options);
}

module.exports = { CoreChild, spawnCore, errorName, specOf };

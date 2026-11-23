// The streaming performance probe in main (docs/performance/measurement.md): event-loop delay, IPC sends, raw adapter events, transcript write times and the windows' samples, as JSON lines in <userData>/perf/<run id>.jsonl while shared.perf.probe is on.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const diagnostics = require('node:diagnostics_channel');
const { noteIgnored } = require('../ignored.cjs');
const { startupMarks, onStartupMark, sinceStart, moduleBreakdowns } = require('./startup.cjs');
const { slowestRequires } = require('./requireTimes.cjs');
const { noteIpc } = require('./stalls.cjs');

/** How often counters are read and written out. */
const TICK_MS = 1000;
/** The loop monitor's timer interval: it records each interval whole, so an idle loop reads this much. */
const RESOLUTION_MS = 10;
/** Lines that may wait for the writer; past this they are dropped and counted, so a stalled disk never grows memory. */
const MAX_QUEUE = 20_000;
/** Samples taken from one window message; the rest of a larger batch is dropped and counted. */
const MAX_BATCH = 5_000;
/** Every this many ticks, each process the app owns is sampled (rust-core.md §2: RSS, CPU, wakeups, spawns). */
const IDLE_TICKS = 10;

/** Electron's view of the app's processes (main, windows, GPU, utilities); none outside Electron. */
function appMetrics() {
  const electron = require('electron');
  return typeof electron === 'object' && electron.app ? electron.app.getAppMetrics() : [];
}

/**
 * A spawn's program and its first plain word (git's subcommand past `-C <dir>`), else the base name of its first path
 * (node's script): what tells one poller from another, never a path or value in full.
 * @param {unknown} file @param {unknown} args the child's spawnargs, its argv[0] first
 */
function spawnName(file, args) {
  const program = path.basename(String(file ?? '?'));
  const words = Array.isArray(args) ? args.slice(1).filter((a) => typeof a === 'string' && a && !a.startsWith('-')) : [];
  const word = words.find((a) => !a.includes('/')) ?? (words[0] && path.basename(words[0]));
  return word ? `${program} ${word.slice(0, 40)}` : program;
}

/** The repository (or packaged app) root the call sites are named from. */
const ROOT = path.join(__dirname, '..', '..');

/**
 * The app's own frames nearest a spawn in its stack, up to three, named from the root (`electron/a.cjs:12 < …`): who
 * started it, past a shared wrapper. Node's own frames and this probe's are skipped; none reads `?`.
 * @param {string} stack @param {string} [root]
 */
function callerOf(stack, root = ROOT) {
  const frames = [];
  for (const line of stack.split('\n')) {
    const at = /^at (?:.+? \()?((?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^()]+?):(\d+):\d+\)?$/.exec(line.trim());
    // an ES module's frames are file URLs
    const file = at && (at[1].startsWith('file://') ? fileURLToPath(at[1]) : at[1]);
    if (!at || !file || file.includes(`${path.sep}node_modules${path.sep}`) || file.endsWith(`perf${path.sep}probe.cjs`)) continue;
    frames.push(`${path.relative(root, file).split(path.sep).join('/')}:${at[2]}`);
    if (frames.length === 3) break;
  }
  return frames.join(' < ') || '?';
}

/** This stack, 50 frames deep: Node's own spawn and channel frames fill the default 10 before the app's. */
function deepStack() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return String(new Error().stack);
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * Counts the child processes started since the last take, from Node's child_process channel (an asynchronous spawn,
 * execFile or exec; a synchronous one is not published there), and names each by its program once it has started (the
 * channel publishes from the constructor, before the program is set; one that fails to start is counted, not named).
 * @param {Pick<typeof diagnostics, 'subscribe' | 'unsubscribe'>} [dc]
 */
function countSpawns(dc = diagnostics, stack = deepStack) {
  let count = 0;
  /** @type {Map<string, number>} */
  let commands = new Map();
  /** @type {Map<string, number>} */
  let sites = new Map();
  const bump = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => m.set(k, (m.get(k) ?? 0) + 1);
  const heard = (/** @type {any} */ message) => {
    count++;
    // the channel publishes inside spawn(): this stack still holds the code that spawned
    const where = callerOf(stack());
    const child = message?.process;
    child?.once?.('spawn', () => {
      const name = spawnName(child.spawnfile, child.spawnargs);
      bump(commands, name);
      bump(sites, `${name} @ ${where}`);
    });
  };
  dc.subscribe('child_process', heard);
  return {
    /** @returns {{ count: number, commands: Record<string, number>, sites: Record<string, number> }} */
    take() {
      const taken = { count, commands: Object.fromEntries(commands), sites: Object.fromEntries(sites) };
      count = 0;
      commands = new Map();
      sites = new Map();
      return taken;
    },
    stop: () => dc.unsubscribe('child_process', heard),
  };
}

/**
 * An asynchronous, bounded JSON-lines writer: one append in flight at a time, everything queued meanwhile goes in the next.
 * @param {string} file
 * @param {{ append?: (file: string, text: string) => Promise<unknown>, mkdir?: (dir: string, o: object) => Promise<unknown>,
 *           max?: number }} [deps]
 */
function createWriter(file, { append = fs.promises.appendFile, mkdir = fs.promises.mkdir, max = MAX_QUEUE } = {}) {
  /** @type {string[]} */
  let queue = [];
  let dropped = 0;
  /** @type {Promise<void> | null} */
  let inflight = null;
  /** @type {Promise<unknown> | null} */
  let folder = null;
  return {
    /** Queues a line; false when the queue is full and the line was dropped. */
    push(/** @type {string} */ line) {
      if (queue.length >= max) {
        dropped++;
        return false;
      }
      queue.push(line);
      return true;
    },
    /** Lines dropped since the last call, which resets the count. */
    takeDropped() {
      const n = dropped;
      dropped = 0;
      return n;
    },
    /** Starts writing what is queued; resolves when that append (or the one already in flight) is done. */
    flush() {
      if (inflight) return inflight;
      if (!queue.length) return Promise.resolve();
      const lines = queue;
      queue = [];
      folder ??= mkdir(path.dirname(file), { recursive: true });
      inflight = folder
        .then(() => append(file, `${lines.join('\n')}\n`))
        .then(
          () => undefined,
          (error) => {
            // the samples of this batch are lost; the next batch tries the folder again
            folder = null;
            noteIgnored('write performance samples', error);
          },
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    /** Writes until nothing is queued or in flight. */
    async drain() {
      while (inflight || queue.length) await this.flush();
    },
  };
}

/** A key of a counter map, and back. */
const keyOf = (/** @type {unknown[]} */ parts) => JSON.stringify(parts);
const partsOf = (/** @type {string} */ key) => JSON.parse(key);
/** A loop monitor reading (nanoseconds) as the delay beyond its timer's interval, in milliseconds with two decimals. */
const delay = (/** @type {number} */ ns) => Math.max(0, Math.round(ns / 1e4 - RESOLUTION_MS * 100) / 100);
/** The chat an adapter event belongs to: Codex names it chatId, Claude Code and ACP key. */
const chatOf = (/** @type {any} */ event) => event?.chatId ?? event?.key ?? null;

/**
 * One run of the probe: its counters, its loop monitor and its writer.
 * @param {{ file: string, now?: () => number, clock?: () => number, monitor?: () => any, writer?: ReturnType<typeof createWriter>,
 *           setInterval?: typeof setInterval, clearInterval?: typeof clearInterval, metrics?: () => any[],
 *           cpuUsage?: () => { user: number, system: number }, spawns?: Pick<ReturnType<typeof countSpawns>, 'take' | 'stop'>,
 *           marks?: typeof startupMarks, onMark?: typeof onStartupMark, breakdowns?: typeof moduleBreakdowns,
 *           requires?: () => ReturnType<typeof slowestRequires>, coreLoaded?: () => boolean | undefined }} o
 *   now: the samples' wall clock; clock: a monotonic clock for write timing; monitor: perf_hooks.monitorEventLoopDelay;
 *   metrics: Electron's app.getAppMetrics; cpuUsage: main's own CPU time (microseconds); marks: the startup timeline;
 *   coreLoaded: whether this run has the Rust core, asked once and written on every line, so a run's numbers can't be
 *   taken for the wrong implementation
 */
function createProbe({
  file,
  now = Date.now,
  clock = () => performance.now(),
  monitor = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS }),
  writer = createWriter(file),
  setInterval: every = setInterval,
  clearInterval: stopEvery = clearInterval,
  metrics = appMetrics,
  cpuUsage = () => process.cpuUsage(),
  spawns = countSpawns(),
  marks = startupMarks,
  onMark = onStartupMark,
  breakdowns = moduleBreakdowns,
  requires = slowestRequires,
  coreLoaded = () => undefined,
}) {
  const onCore = coreLoaded();
  /** One line of the file. The run's coreLoaded comes last: a window's sample can't speak for it. */
  const line = (/** @type {Record<string, unknown>} */ s) => JSON.stringify({ t: now(), ...s, coreLoaded: onCore });
  const loop = monitor();
  loop.enable();
  /** @type {Map<string, number>} */
  const ipc = new Map();
  /** @type {Map<string, number>} */
  const raw = new Map();
  /** @type {Map<string, { count: number, ms: number, max: number }>} each channel's answered invokes this second */
  const invokes = new Map();
  const bump = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => m.set(k, (m.get(k) ?? 0) + 1);
  const sample = (/** @type {Record<string, unknown>} */ s) => writer.push(line(s));
  // the startup timeline so far, then each later mark as it comes
  for (const m of marks()) sample({ kind: 'mark', ...m });
  const stopMarks = onMark((m) => sample({ kind: 'mark', ...m }));
  // what main had loaded by package at startup (recorded at whenReady, before any probe runs)
  for (const b of breakdowns()) sample({ kind: 'modules', ...b });
  // each file's own load time so far, when boot timed them (MOPILOT_REQUIRE_TIMES=1)
  const loaded = requires();
  if (loaded.files) sample({ kind: 'requires', ...loaded });
  let ticks = 0;

  /** Each process the app owns, main's CPU time and the child processes started since the last time. */
  function sampleProcesses() {
    for (const m of metrics())
      sample({
        kind: 'proc',
        type: m.type,
        pid: m.pid,
        rssKb: m.memory?.workingSetSize ?? null,
        cpuPct: m.cpu?.percentCPUUsage ?? null,
        wakeups: m.cpu?.idleWakeupsPerSecond ?? null,
      });
    const cpu = cpuUsage();
    sample({ kind: 'cpu', userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000) });
    sample({ kind: 'spawns', ...spawns.take() });
  }

  function tick() {
    sample({
      kind: 'loop',
      p50: delay(loop.percentile(50)),
      p95: delay(loop.percentile(95)),
      p99: delay(loop.percentile(99)),
      max: delay(loop.max),
    });
    loop.reset();
    for (const [k, count] of ipc) {
      const [channel, window] = partsOf(k);
      sample({ kind: 'ipc', channel, window, count });
    }
    ipc.clear();
    const ms = (/** @type {number} */ x) => Math.round(x * 10) / 10;
    for (const [channel, v] of invokes) sample({ kind: 'invoke', channel, count: v.count, ms: ms(v.ms), max: ms(v.max) });
    invokes.clear();
    for (const [k, count] of raw) {
      const [harness, chat] = partsOf(k);
      sample({ kind: 'raw', harness, chat, count });
    }
    raw.clear();
    if (++ticks % IDLE_TICKS === 0) sampleProcesses();
    const dropped = writer.takeDropped();
    // past the bound on purpose: the count of what was lost is the one line a reader needs
    if (dropped) writer.push(line({ kind: 'dropped', count: dropped }));
    void writer.flush();
  }
  const timer = every(tick, TICK_MS);
  timer.unref?.();

  return {
    file,
    ipc: (/** @type {string} */ channel, /** @type {number} */ window) => bump(ipc, keyOf([channel, window])),
    raw: (/** @type {string} */ harness, /** @type {string | null} */ chat) => bump(raw, keyOf([harness, chat])),
    invoke: (/** @type {string} */ channel, /** @type {number} */ took) => {
      const v = invokes.get(channel) ?? { count: 0, ms: 0, max: 0 };
      invokes.set(channel, { count: v.count + 1, ms: v.ms + took, max: Math.max(v.max, took) });
    },
    sample,
    clock,
    /** Takes the last second's counters and writes everything out. */
    async stop() {
      stopEvery(timer);
      stopMarks();
      spawns.stop();
      tick();
      loop.disable();
      await writer.drain();
    },
  };
}

/** @type {ReturnType<typeof createProbe> | null} */
let active = null;

/** A run id that sorts by start time and never repeats between two instances. */
const runId = (/** @type {Date} */ at = new Date(), pid = process.pid) => `${at.toISOString().replace(/[:.]/g, '-')}-${pid}`;

/**
 * Starts the probe (once); returns the file it writes. Deps are for tests.
 * @param {{ dir: string, id?: string } & Omit<Parameters<typeof createProbe>[0], 'file'>} o
 */
function startProbe({ dir, id = runId(), ...deps }) {
  active ??= createProbe({ file: path.join(dir, 'perf', `${id}.jsonl`), ...deps });
  return active.file;
}

/** Stops the probe, writing out what it holds; resolves once that is on disk. */
function stopProbe() {
  const p = active;
  active = null;
  return p ? p.stop() : Promise.resolve();
}

/**
 * Follows the flag: starts the probe when it turns on, stops it when it turns off.
 * @param {boolean} on
 * @param {string} dir the user data folder
 * @param {() => boolean} [coreLoaded] whether this process has the Rust core
 */
function syncProbe(on, dir, coreLoaded) {
  if (on) startProbe({ dir, coreLoaded });
  else if (active) void stopProbe();
}

/**
 * `ipcMain` with each handler's answer timed per channel while the probe runs (`invoke` samples): how long a window waits
 * on main for what it asks. With the probe off a handler runs as registered, behind one check.
 * @template {{ handle: Function, handleOnce: Function }} T
 * @param {T} ipcMain @param {() => number} [clock]
 * @returns {T}
 */
function timedIpc(ipcMain, clock = () => performance.now()) {
  /** @param {string} channel @param {Function} fn @param {any[]} args */
  const timed = async (channel, fn, args) => {
    const start = clock();
    try {
      return await fn(...args);
    } finally {
      active?.invoke(channel, clock() - start);
    }
  };
  // off, the handler's own answer as it gives it (a value stays a value); `handles` names the handler it wraps
  const time = (/** @type {string} */ channel, /** @type {Function} */ fn) =>
    Object.assign(
      (/** @type {any[]} */ ...args) => {
        // the stall logger's ring (electron/perf/stalls.cjs) names the calls inside a stall, probe on or off
        noteIpc(channel);
        return active ? timed(channel, fn, args) : fn(...args);
      },
      { handles: fn },
    );
  return new Proxy(ipcMain, {
    get(target, prop) {
      const value = /** @type {any} */ (Reflect.get(target, prop));
      if (prop === 'handle' || prop === 'handleOnce')
        return (/** @type {string} */ channel, /** @type {Function} */ fn) => value.call(target, channel, time(channel, fn));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** One IPC message main sent a window on `channel`. */
function countIpc(/** @type {string} */ channel, /** @type {number} */ windowId) {
  active?.ipc(channel, windowId);
}

/** The adapters' channels to windows, by harness family. */
const ADAPTER_CHANNELS = Object.freeze({ 'codex:item': 'codex', 'claude:event': 'claude', 'acp:event': 'acp' });

/** A broadcast to every window: an adapter event when it is on an adapter's channel (Claude Code's and the ACP host's stream). */
function countBroadcast(/** @type {string} */ channel, /** @type {unknown} */ event) {
  const harness = /** @type {Record<string, string>} */ (ADAPTER_CHANNELS)[channel];
  if (harness) countRaw(harness, event);
}

/** One event an adapter emitted, before anything batches it. @param {string} harness codex, claude or acp */
function countRaw(harness, /** @type {unknown} */ event) {
  active?.raw(harness, chatOf(event));
}

/** Whether writes are being sampled. */
const probing = () => active !== null;

/**
 * A batch the transcript crate wrote (electron/platform/transcriptWriter.cjs): its chat, size, time and why it was written.
 * @param {{ chat: string, records: number, bytes: number, ms: number, reason: string }} write
 */
function recordWrite(write) {
  active?.sample({ kind: 'write', ...write });
}

/**
 * A window's samples (src/session/perf.ts), stamped with the window they came from. Anything that is not a sample object
 * with a string kind is skipped; past MAX_BATCH the rest is dropped and counted. A mark sent with its wall-clock time
 * (`at`) is written with its time since this process started, as main's own marks are.
 * @param {number} windowId the sender's webContents id
 * @param {unknown} batch
 */
function recordWindowSamples(windowId, batch) {
  const p = active;
  if (!p || !Array.isArray(batch)) return;
  let dropped = Math.max(0, batch.length - MAX_BATCH);
  for (const s of batch.slice(0, MAX_BATCH)) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.kind !== 'string') {
      dropped++;
      continue;
    }
    // a window's startup mark (first paint, first chat interactive) comes as wall-clock time: on main's timeline here
    if (s.kind === 'mark' && typeof s.name === 'string' && typeof s.at === 'number')
      p.sample({ kind: 'mark', name: s.name, ms: sinceStart(s.at), window: windowId });
    else p.sample({ ...s, window: windowId });
  }
  if (dropped) p.sample({ kind: 'dropped', window: windowId, count: dropped });
}

module.exports = {
  timedIpc,
  spawnName,
  callerOf,
  TICK_MS,
  RESOLUTION_MS,
  IDLE_TICKS,
  appMetrics,
  countSpawns,
  MAX_QUEUE,
  MAX_BATCH,
  createWriter,
  createProbe,
  runId,
  startProbe,
  stopProbe,
  syncProbe,
  countIpc,
  countRaw,
  countBroadcast,
  probing,
  recordWrite,
  recordWindowSamples,
  chatOf,
};

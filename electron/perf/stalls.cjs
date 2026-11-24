// The always-on stall logger in main (docs/performance/measurement.md): a 200 ms timer measures how late it fires; a stall past 500 ms is logged with the window state, rss and the label of the last long synchronous task, and kept in a bounded <userData>/perf/stalls.jsonl. Independent of shared.perf.probe.
const fs = require('node:fs');
const path = require('node:path');
const diagnostics = require('node:diagnostics_channel');

/** The timer's period. */
const INTERVAL_MS = 200;
/** A timer that fires this much late is a stall. */
const STALL_MS = 500;
/** A labeled task at least this long is remembered as the last long synchronous task. */
const LONG_TASK_MS = 50;
/** The log is rotated to stalls.1.jsonl once it reaches this size, so it never grows past about twice this. */
const MAX_BYTES = 256 * 1024;
/** A log that cannot be written warns once in this long. */
const WARN_EVERY_MS = 60_000;

/** How many IPC calls and long tasks the logger remembers, and how many of each a stall line names. */
const RING = 32;
const LINE_MAX = 8;

/** @typedef {{ label: string, ms: number, start: number, end: number }} LongTask */

/** Labels of the labeled tasks running now, outermost first. @type {string[]} */
const stack = [];
/** @type {LongTask | null} */
let lastLong = null;
let clockFn = performance.now.bind(performance);
/** The last RING IPC calls (channel and when they started) and long tasks, oldest overwritten first: a stall names the ones inside it. */
const ipcRing = { at: new Array(RING).fill(-1), channel: new Array(RING).fill(''), next: 0 };
/** @type {LongTask[]} */
const longRing = [];

/** Notes that an IPC handler is starting: two array writes, the whole always-on cost. @param {string} channel */
function noteIpc(channel) {
  ipcRing.at[ipcRing.next] = clockFn();
  ipcRing.channel[ipcRing.next] = channel;
  ipcRing.next = (ipcRing.next + 1) % RING;
}

/** The channels of IPC calls that started at or after `from`, with how often each ran, most frequent first. */
function ipcSince(/** @type {number} */ from) {
  const counts = new Map();
  for (let i = 0; i < RING; i++) if (ipcRing.at[i] >= from) counts.set(ipcRing.channel[i], (counts.get(ipcRing.channel[i]) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LINE_MAX)
    .map(([channel, n]) => ({ channel, n }));
}

/** The long tasks that ended at or after `from`, newest first. */
const tasksSince = (/** @type {number} */ from) =>
  longRing
    .filter((t) => t.end >= from)
    .reverse()
    .slice(0, LINE_MAX)
    .map((t) => ({ label: t.label, ms: t.ms }));

/**
 * Runs a synchronous function under a label (like Claude Desktop's Yi(label)); a stall that follows a long run names it.
 * Nested labels form a path ("outer>inner"); returns what `fn` returns and rethrows what it throws.
 * @template T
 * @param {string} label
 * @param {() => T} fn
 * @returns {T}
 */
function labeled(label, fn) {
  const named = stack.length ? `${stack.join('>')}>${label}` : label;
  const start = clockFn();
  stack.push(label);
  try {
    return fn();
  } finally {
    stack.pop();
    const end = clockFn();
    // an inner task that ran long during this one is the more specific answer: its path already starts with this label
    const inner = lastLong !== null && lastLong.end > start;
    if (end - start >= LONG_TASK_MS && !inner) {
      lastLong = { label: named, ms: Math.round(end - start), start, end };
      longRing.push(lastLong);
      if (longRing.length > RING) longRing.shift();
    }
  }
}

/** How late a timer fired: elapsed since the previous tick beyond its period, never negative. */
const lateness = (/** @type {number} */ prev, /** @type {number} */ at, interval = INTERVAL_MS) => Math.max(0, at - prev - interval);

/**
 * Appends JSON lines to a file that is rotated to <name>.1.jsonl at `max` bytes; one append at a time, failures noted.
 * @param {string} file
 * @param {{ max?: number, fsp?: Pick<typeof fs.promises, 'appendFile' | 'mkdir' | 'rename' | 'stat'>, warn?: (...a: unknown[]) => void, now?: () => number }} [o]
 */
function createBoundedLog(file, { max = MAX_BYTES, fsp = fs.promises, warn = console.warn, now = Date.now } = {}) {
  /** @type {number | null} */
  let size = null;
  let made = false;
  let chain = Promise.resolve();
  const rotated = file.replace(/\.jsonl$/, '.1.jsonl');
  const write = async (/** @type {string} */ line) => {
    // the folder is made once, not on every line
    if (!made) {
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      made = true;
    }
    size ??= await fsp.stat(file).then(
      (s) => s.size,
      () => 0,
    );
    const bytes = Buffer.byteLength(line) + 1;
    if (size >= max) {
      await fsp.rename(file, rotated);
      size = 0;
    }
    await fsp.appendFile(file, `${line}\n`, { mode: 0o600 });
    size += bytes;
  };
  // a full or unwritable disk fails every line: one warning a minute, with how many it stood for
  let warnedAt = -Infinity;
  let silenced = 0;
  const failed = (/** @type {unknown} */ error) => {
    // the folder or the file may have been removed: look again at both on the next line
    made = false;
    size = null;
    const at = now();
    if (at - warnedAt < WARN_EVERY_MS) {
      silenced += 1;
      return;
    }
    warnedAt = at;
    warn('[perf] could not write the stall log:', error, silenced ? `(${silenced} more lines failed since the last warning)` : '');
    silenced = 0;
  };
  return {
    /** Queues a line; resolves once it is written (or its failure noted). */
    append(/** @type {string} */ line) {
      chain = chain.then(() => write(line)).catch(failed);
      return chain;
    },
  };
}

/** The window state of an Electron app: whether one is focused and whether one is on screen. */
function windowState(/** @type {{ BrowserWindow: any }} */ { BrowserWindow }, warn = console.warn) {
  try {
    const all = BrowserWindow.getAllWindows();
    return {
      focused: !!BrowserWindow.getFocusedWindow(),
      visible: all.some((/** @type {any} */ w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()),
    };
  } catch (error) {
    // a timer must never throw in main; the line is still worth writing
    warn('[perf] could not read the window state for a stall:', error);
    return { focused: false, visible: false };
  }
}

/**
 * Starts the logger. Deps are for tests.
 * @param {object} o
 * @param {string} o.dir the user data folder
 * @param {{ BrowserWindow: any, powerMonitor?: { on(event: string, cb: () => void): unknown, removeListener(event: string, cb: () => void): unknown } }} [o.electron] defaults to Electron itself
 * @param {() => number} [o.now] wall clock for the lines
 * @param {() => number} [o.clock] monotonic ms
 * @param {typeof setInterval} [o.setInterval]
 * @param {typeof clearInterval} [o.clearInterval]
 * @param {() => number} [o.rss] resident set size in bytes
 * @param {{ append(line: string): unknown }} [o.log]
 * @param {(...a: unknown[]) => void} [o.warn] the app log
 */
function startStallLogger({
  dir,
  // perf is a platform-layer domain (boundary.json L1), so it may read Electron itself
  electron = require('electron'),
  now = Date.now,
  clock = () => performance.now(),
  setInterval: every = setInterval,
  clearInterval: stopEvery = clearInterval,
  rss = () => process.memoryUsage.rss(),
  log = createBoundedLog(path.join(dir, 'perf', 'stalls.jsonl')),
  warn = console.warn,
}) {
  clockFn = clock;
  lastLong = null;
  longRing.length = 0;
  ipcRing.at.fill(-1);
  let prev = clock();
  let prevRss = rss();
  // child processes started, from Node's channel: a counter, so a stall can say whether main was spawning
  let spawned = 0;
  let spawnedPrev = 0;
  const countSpawn = () => {
    spawned++;
  };
  diagnostics.subscribe('child_process', countSpawn);
  /** A sleep or wake in between: the next tick spans it and is not measured. */
  let skip = false;
  let count = 0;
  let maxMs = 0;
  const suspend = () => {
    skip = true;
  };
  const resume = () => {
    skip = true;
    prev = clock();
  };
  electron.powerMonitor?.on('suspend', suspend);
  electron.powerMonitor?.on('resume', resume);

  function tick() {
    const at = clock();
    const late = lateness(prev, at);
    const from = prev;
    prev = at;
    const heldRss = prevRss;
    const spawnsBefore = spawnedPrev;
    spawnedPrev = spawned;
    const nowRss = rss();
    prevRss = nowRss;
    if (skip) {
      skip = false;
      return;
    }
    if (late <= STALL_MS) return;
    count++;
    maxMs = Math.max(maxMs, late);
    const task = lastLong !== null && lastLong.end > from ? lastLong : null;
    const line = {
      t: now(),
      kind: 'stall',
      ms: Math.round(late),
      ...windowState(electron, warn),
      rss: nowRss,
      // growth since the last tick before the stall, what ran inside it, and the processes started meanwhile
      rssDelta: nowRss - heldRss,
      ipc: ipcSince(from),
      tasks: tasksSince(from),
      spawns: spawned - spawnsBefore,
      label: task?.label ?? null,
      labelMs: task?.ms ?? null,
    };
    warn(`[perf] main process stalled ${line.ms} ms${task ? ` in ${task.label} (${task.ms} ms)` : ''}`);
    void log.append(JSON.stringify(line));
  }
  const timer = every(tick, INTERVAL_MS);
  timer.unref?.();

  return {
    /** Stalls seen so far and the longest one. */
    stats: () => ({ count, maxMs: Math.round(maxMs) }),
    stop() {
      stopEvery(timer);
      diagnostics.unsubscribe('child_process', countSpawn);
      electron.powerMonitor?.removeListener('suspend', suspend);
      electron.powerMonitor?.removeListener('resume', resume);
    },
  };
}

module.exports = {
  INTERVAL_MS,
  STALL_MS,
  LONG_TASK_MS,
  MAX_BYTES,
  RING,
  LINE_MAX,
  noteIpc,
  labeled,
  lateness,
  createBoundedLog,
  windowState,
  startStallLogger,
};

// The built-in browser's memory guard, for every harness: a page must not take MoPilot down by growing the main process until it runs out of memory.
//
// - Web storage (IndexedDB, DOM storage) and the browser side of every page live in the main process.
//   A page can make them grow without bound: two tabs of one site whose storage events dispatch into
//   each other open IndexedDB connections thousands of times a second, Chromium queues a main-thread
//   task per connection, and the process passes 10 GB within a minute and dies (SIGTRAP in
//   partition_alloc's OnNoMemory). Google Chrome's own browser process grows the same way on that site.
// - The flood starves the main thread (its timers run tens of seconds late), so the guard samples the
//   process's memory from a worker thread and stops the browser pages' renderers from there with
//   SIGKILL. Main posts the worker their process ids; app windows' processes are never on the list.
// - The trigger is the growth rate, not a level: GROWTH within WINDOW beyond main's own JS is never normal, and
//   stopping the pages early bounds what Chromium still has queued (measured: stopped at +0.5 GB the
//   process settled near 3 GB; stopped at 2 GB it climbed to 9 GB before it recovered).
// - Main's own work grows the process too (a chat's history read or a large harness response can add
//   half a gigabyte in a second while it is parsed), so main reports its own JS memory (V8 heap and
//   external) every OWN_MS and the worker counts only the growth that report does not explain. A flood
//   grows Chromium's native memory, not main's JS, and starves main's event loop: when growth crosses
//   the limit and no newer report arrives within confirmMs, the pages are stopped as before.
// - Main's list of processes can be stale while it is starved, so the worker kills only a process
//   this one started (its parent), never a reused pid.
// - A stopped page shows the pane's crashed notice with the memory reason (BrowserWindows
//   stoppedForMemory, in whichever order its crash and the worker's report arrive) and reloads from it.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { messageOf, noteIgnored } = require('../../ignored.cjs');

const MIB = 1024 * 1024;
const LIMITS = Object.freeze({
  /** how often the worker reads the process's memory */
  sampleMs: 250,
  /** growth over this window is measured from its lowest sample */
  windowMs: 10_000,
  /** growth that stops the browser pages */
  growthBytes: 512 * MIB,
  /** after a stop, no other while what Chromium already queued drains */
  cooldownMs: 30_000,
  /** past the limit, how long to wait for main's next report of its own memory before taking main as starved */
  confirmMs: 1000,
});
/** The core's loader, which the worker requires by this path: an evaluated source has no folder of its own to resolve from. */
const CORE_MODULE = path.join(__dirname, '..', '..', 'platform', 'core.cjs');
/** How often main tells the worker the browser pages' processes (a navigation can swap a page's process). */
const REFRESH_MS = 1000;
/** How often main tells the worker its own JS memory (as often as the worker samples). */
const OWN_MS = LIMITS.sampleMs;
const MEMORY_MESSAGE =
  'MoPilot stopped this page because the browser was using up its memory (this can happen when the same site is open in several tabs). Reload it to continue.';

/**
 * The worker's loop, self-contained (it runs from its source in the worker): samples rss() every
 * sampleMs; when it grew by growthBytes within windowMs beyond what main's own JS memory grew (main
 * posts { own }), and main confirmed it with a newer report or posted none for confirmMs, kills the
 * pids main posted last and posts { stopped, failed, fromBytes, toBytes, ownBytes, ms }, then waits
 * out cooldownMs.
 * @param {{ on(event: 'message', fn: (m: any) => void): void, postMessage(m: any): void }} port
 * @param {() => number} rss
 * @param {(pid: number) => void} kill
 * @param {(fn: () => void, ms: number) => void} every
 * @param {() => number} now
 * @param {{ sampleMs: number, windowMs: number, growthBytes: number, cooldownMs: number, confirmMs: number }} limits
 */
function guardWorkerMain(port, rss, kill, every, now, limits) {
  /** @type {number[]} */
  let pids = [];
  /** own: main's JS memory at the sample; peak: the most main reported since the sample before it */
  /** @type {{ t: number, bytes: number, own: number, peak: number }[]} */
  let samples = [];
  let quietUntil = 0;
  // main's latest report of its own JS memory, the highest since the last sample, and when it arrived
  let own = 0;
  let peak = 0;
  let ownAt = Number.NEGATIVE_INFINITY;
  // when unexplained growth first crossed the limit (0: it has not)
  let crossedAt = 0;
  port.on('message', (m) => {
    if (Array.isArray(m?.pids)) pids = m.pids.filter((p) => Number.isInteger(p) && p > 0);
    if (Number.isFinite(m?.own) && m.own >= 0) {
      own = m.own;
      peak = Math.max(peak, own);
      ownAt = now();
    }
  });
  every(() => {
    const t = now();
    if (t < quietUntil) return;
    const bytes = rss();
    samples = samples.filter((s) => t - s.t <= limits.windowMs);
    samples.push({ t, bytes, own, peak });
    peak = own;
    const low = samples.reduce((a, s) => (s.bytes < a.bytes ? s : a));
    // what main's own JS grew to since the lowest sample explains that much (memory it freed may still be resident)
    const ownGrowth = Math.max(0, ...samples.filter((s) => s.t > low.t).map((s) => s.peak - low.own));
    if (bytes - low.bytes - ownGrowth < limits.growthBytes) {
      crossedAt = 0;
      return;
    }
    if (!crossedAt) crossedAt = t;
    // main's own work may have grown since its last report: wait for a newer one, unless main is starved
    if (ownAt <= crossedAt && t - crossedAt < limits.confirmMs) return;
    const stopped = [];
    const failed = [];
    for (const pid of pids) {
      try {
        kill(pid);
        stopped.push(pid);
      } catch (error) {
        // usually the process already went; main logs it with the stop
        failed.push(`${pid}: ${error?.message ?? error}`);
      }
    }
    samples = [];
    crossedAt = 0;
    quietUntil = t + limits.cooldownMs;
    port.postMessage({ stopped, failed, fromBytes: low.bytes, toBytes: bytes, ownBytes: ownGrowth, ms: t - low.t });
  }, limits.sampleMs);
}

/**
 * SIGKILLs `pid` only while it is a child of this process: a renderer main started, not a process
 * that reused the pid of one that went. Throws otherwise, also when the core can't say whose it is. (Windows has no pid
 * reuse this fast.) Self-contained, like guardWorkerMain.
 */
function killChild(pid, o) {
  if (o.platform !== 'win32') {
    const parent = o.parentOf(pid);
    if (parent !== o.self) throw new Error(`not a process of this app (parent ${parent || 'none'})`);
  }
  o.kill(pid, 'SIGKILL');
}

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { core, coreSyncCall } = require(workerData.core);
const killChild = ${killChild};
const parentOf = (pid) => coreSyncCall(core(), 'proc.table', '').find((row) => row[0] === pid)?.[1];
// why this worker can't place a process: null when it can, the core's reason when the table can't be read
const unplaced = () => {
  try {
    return parentOf(process.pid) === undefined ? 'this process is not in it' : null;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
// loaded and tried now, while main is well: a flood is no time to find it can't be, and nothing else stops a page
const why = process.platform === 'win32' ? null : unplaced();
parentPort.postMessage(why === null ? { ready: true } : { ready: false, why });
(${guardWorkerMain})(parentPort, () => process.memoryUsage().rss, (pid) => killChild(pid, { platform: process.platform, parentOf, self: process.pid, kill: process.kill.bind(process) }), (fn, ms) => setInterval(fn, ms), Date.now, workerData.limits);
`;

class MemoryGuard {
  /**
   * @param {{ pages: () => any[], appContents: () => any[], makeWorker?: (src: string, o: object) => any,
   *           every?: (fn: () => void, ms: number) => any, limits?: typeof LIMITS, log?: (line: string) => void,
   *           onStopped?: (wc: any) => void, onReady?: (problem: string | null) => void, memoryUsage?: () => { heapTotal: number, external: number } }} o
   *   pages: the built-in browser's live pages (pane tabs, guests and their popups)
   *   appContents: MoPilot's own windows' webContents, whose processes are never stopped
   *   onStopped: a page whose renderer the guard stopped (BrowserWindows.stoppedForMemory)
   *   onReady: once, whether the worker can stop pages: null, or why not (a release's smoke launch fails on that)
   */
  constructor(o) {
    this.o = o;
    this.makeWorker = o.makeWorker ?? ((src, opts) => new Worker(src, opts));
    this.every = o.every ?? ((fn, ms) => setInterval(fn, ms));
    this.log = o.log ?? ((line) => console.warn(line));
    this.worker = null;
    this.timer = null;
    this.ownTimer = null;
    /** pid -> the pages in it, as last posted: a killed renderer no longer reports its pid */
    this.byPid = new Map();
  }

  /** Starts the worker and keeps it told of the pages' processes. */
  start() {
    if (this.worker) return;
    const w = this.makeWorker(WORKER_SOURCE, { eval: true, workerData: { limits: this.o.limits ?? LIMITS, core: CORE_MODULE } });
    this.worker = w;
    // the guard never keeps the app running
    w.unref?.();
    w.on('message', (m) =>
      m?.ready === undefined
        ? this.#stopped(m)
        : this.#ready(m.ready ? null : `its worker read no process table${m.why ? `: ${m.why}` : ''}`),
    );
    w.on('error', (error) => {
      noteIgnored('run the browser memory guard', error);
      this.#ready(`its worker failed: ${messageOf(error)}`);
    });
    w.on('exit', () => {
      if (this.worker === w) this.stop();
      this.#ready('its worker ended');
    });
    this.timer = this.every(() => this.refresh(), REFRESH_MS);
    this.timer?.unref?.();
    this.ownTimer = this.every(() => this.reportOwn(), OWN_MS);
    this.ownTimer?.unref?.();
    this.refresh();
    this.reportOwn();
  }

  stop() {
    const w = this.worker;
    this.worker = null;
    clearInterval(this.timer);
    clearInterval(this.ownTimer);
    this.timer = null;
    this.ownTimer = null;
    if (w) Promise.resolve(w.terminate()).catch((error) => noteIgnored('stop the browser memory guard', error));
  }

  /** The browser pages by renderer process, never one an app window uses. */
  pagesByPid() {
    const own = new Set(this.o.appContents().map(pidOf));
    const byPid = new Map();
    for (const wc of this.o.pages()) {
      const pid = pidOf(wc);
      if (pid > 0 && !own.has(pid)) byPid.set(pid, [...(byPid.get(pid) ?? []), wc]);
    }
    return byPid;
  }

  refresh() {
    if (!this.worker) return;
    this.byPid = this.pagesByPid();
    this.worker.postMessage({ pids: [...this.byPid.keys()] });
  }

  /** Tells the worker main's own JS memory: growth it explains is main's work, not the pages'. */
  reportOwn() {
    if (!this.worker) return;
    const { heapTotal, external } = (this.o.memoryUsage ?? process.memoryUsage)();
    this.worker.postMessage({ own: heapTotal + external });
  }

  /** The worker's first word: told once. It has no fallback, so a guard that can't work must be heard. */
  #ready(/** @type {string | null} */ problem) {
    if (this.told) return;
    this.told = true;
    if (problem) this.log(`[browser-memory] no page can be stopped: ${problem}`);
    this.o.onReady?.(problem);
  }

  #stopped(m) {
    let count = 0;
    for (const pid of Array.isArray(m?.stopped) ? m.stopped : [])
      for (const wc of this.byPid.get(pid) ?? []) {
        this.o.onStopped?.(wc);
        count++;
      }
    const mb = (bytes) => Math.round((Number(bytes) || 0) / MIB);
    this.log(
      `[browser-memory] stopped ${count} browser page(s): the main process grew from ${mb(m?.fromBytes)} MB to ${mb(m?.toBytes)} MB in ${Math.round((Number(m?.ms) || 0) / 1000)} s` +
        (Number(m?.ownBytes) > 0 ? ` (${mb(m.ownBytes)} MB of it main's own)` : '') +
        (Array.isArray(m?.failed) && m.failed.length ? `; could not stop ${m.failed.join(', ')}` : ''),
    );
  }
}

/** A webContents' renderer process id, or 0 while it has none (gone, or not started). */
function pidOf(wc) {
  try {
    return !wc || wc.isDestroyed() ? 0 : Number(wc.getOSProcessId()) || 0;
  } catch (error) {
    noteIgnored("read a browser page's process id", error);
    return 0;
  }
}

module.exports = { MemoryGuard, guardWorkerMain, killChild, LIMITS, REFRESH_MS, OWN_MS, MEMORY_MESSAGE, WORKER_SOURCE, CORE_MODULE };

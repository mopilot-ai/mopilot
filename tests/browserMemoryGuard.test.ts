// The built-in browser's memory guard: its worker stops the browser pages' renderers when the main process grows by GROWTH
// within WINDOW beyond what main's own JS grew (a page flooding Chromium's storage side, which starves main), never an
// app window's, and never for main's own work; the pane says why the page stopped.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { CRASHED_MESSAGE as CRASHED } from '../shared/browserNotice.mjs';

const require = createRequire(import.meta.url);
const guard = require('../electron/capabilities/browser/memoryGuard.cjs');
const { MemoryGuard, guardWorkerMain, killChild, LIMITS, REFRESH_MS, OWN_MS, MEMORY_MESSAGE, WORKER_SOURCE, CORE_MODULE } = guard;
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { browserWorld } = require('./helpers/browser.cjs');

const MB = 1024 * 1024;
const limits = { sampleMs: 250, windowMs: 10_000, growthBytes: 512 * MB, cooldownMs: 30_000, confirmMs: 1000 };

/** guardWorkerMain with a fake port, clock, memory and kill. */
function worker(o: { kill?: (pid: number) => void } = {}) {
  const port = new EventEmitter() as any;
  const posted: any[] = [];
  port.postMessage = (m: any) => posted.push(m);
  let t = 0;
  let bytes = 300 * MB;
  const killed: number[] = [];
  let tick: () => void = () => {};
  let every = 0;
  guardWorkerMain(
    port,
    () => bytes,
    o.kill ??
      ((pid: number) => {
        killed.push(pid);
      }),
    (fn: () => void, ms: number) => {
      tick = fn;
      every = ms;
    },
    () => t,
    limits,
  );
  return {
    port,
    posted,
    killed,
    every: () => every,
    /** main reports its own JS memory (MB) now */
    own(mb: number) {
      port.emit('message', { own: mb * MB });
    },
    /** advance the clock by ms, let main report `own` MB if given (a starved main reports nothing), and sample at `mb` */
    at(ms: number, mb: number, own?: number) {
      t += ms;
      if (own !== undefined) this.own(own);
      bytes = mb * MB;
      tick();
    },
  };
}

test('the worker stops the pages once main confirms growth its own JS does not explain, then waits out the cooldown', () => {
  const w = worker();
  assert.equal(w.every(), 250);
  w.port.emit('message', { pids: [11, 12, 0, -3, 1.5, 'x'] });
  w.at(250, 300, 50);
  w.at(250, 700, 50);
  assert.deepEqual(w.killed, []);
  // past the limit, measured against main's report from before it: main may have grown since, so it waits for the next
  w.at(250, 812, 50);
  assert.deepEqual(w.killed, []);
  w.at(250, 830, 50);
  assert.deepEqual(w.killed, [11, 12]);
  assert.deepEqual(w.posted, [{ stopped: [11, 12], failed: [], fromBytes: 300 * MB, toBytes: 830 * MB, ownBytes: 0, ms: 750 }]);
  // still growing while Chromium drains its queue: no second stop during the cooldown
  w.at(10_000, 3000);
  w.at(19_000, 3100);
  assert.equal(w.posted.length, 1);
  // after it, the window starts over from the new level
  w.at(1_000, 3100);
  w.at(250, 3200);
  assert.equal(w.posted.length, 1);
  w.at(250, 3612);
  assert.equal(w.posted.length, 1);
  // main says nothing for confirmMs (a flood starves it): the pages are stopped all the same
  w.at(750, 3700);
  assert.equal(w.posted.length, 1);
  w.at(250, 3800);
  assert.equal(w.posted.length, 2);
  assert.equal(w.posted[1].ms, 1500);
});

test("main's own work, however large, never stops a page; a flood on top of it still does", () => {
  const w = worker();
  w.port.emit('message', { pids: [7] });
  // measured idle in a dev instance: the sidebar re-read every chat's history once a minute
  for (const [mb, own] of [
    [214, 31],
    [866, 545],
    [542, 170],
    [1120, 732],
    [1083, 733],
    [362, 40],
    [300, 40],
  ])
    w.at(250, mb, own);
  assert.deepEqual(w.killed, []);
  // heap that main grew and freed between two samples still counts: the process may keep those pages resident
  w.own(640);
  w.own(60);
  w.at(250, 900, 60);
  w.at(250, 910, 60);
  assert.deepEqual(w.killed, []);
  // the low sample moves past main's spike; a flood then grows the process while main's own memory stays put
  w.at(10_250, 400, 60);
  w.at(250, 700, 60);
  w.at(250, 950, 60);
  w.at(250, 1000, 60);
  assert.deepEqual(w.killed, [7]);
  assert.equal(w.posted[0].fromBytes, 400 * MB);
  assert.equal(w.posted[0].ownBytes, 0);
});

test("a crossing that main's next report explains is dropped, and the wait for confirmation starts over", () => {
  const w = worker();
  w.port.emit('message', { pids: [8] });
  w.at(250, 300, 50);
  // main is busy parsing: rss jumps before its report
  w.at(250, 900);
  w.at(250, 905, 640);
  w.at(250, 905, 640);
  assert.deepEqual(w.killed, []);
  // a later crossing waits its own confirmMs, not the old one's
  w.at(250, 1500);
  w.at(750, 1510);
  assert.deepEqual(w.killed, []);
  w.at(250, 1520);
  assert.deepEqual(w.killed, [8]);
  assert.equal(w.posted[0].ownBytes, 590 * MB);
  assert.equal(w.posted[0].toBytes, 1520 * MB);
});

test('slow growth spread past the window does not stop anything; growth counts from the lowest sample', () => {
  const w = worker();
  w.port.emit('message', { pids: [5] });
  for (let i = 0; i < 12; i++) w.at(2_000, 300 + i * 100);
  assert.deepEqual(w.killed, []);
  // a message without a list or a report keeps the last ones; a bad report is ignored
  w.port.emit('message', { other: true });
  w.port.emit('message', null);
  w.port.emit('message', { own: -1 });
  w.port.emit('message', { own: 'x' });
  w.at(250, 2000);
  w.at(1000, 2000);
  assert.deepEqual(w.killed, [5]);
  // growth is measured from the window's lowest sample, not its first
  const d = worker();
  d.port.emit('message', { pids: [6] });
  d.at(250, 900, 0);
  d.at(250, 300, 0);
  d.at(250, 700, 0);
  assert.deepEqual(d.killed, []);
  d.at(250, 812, 0);
  d.at(250, 812, 0);
  assert.deepEqual(d.killed, [6]);
  assert.equal(d.posted[0].fromBytes, 300 * MB);
});

test('a page process that already went is skipped; the others still stop', () => {
  const w = worker({
    kill: (pid) => {
      if (pid === 1) throw new Error('ESRCH');
      if (pid === 3) throw 'EPERM';
    },
  });
  w.port.emit('message', { pids: [1, 2, 3] });
  w.at(250, 300, 0);
  w.at(250, 900, 0);
  w.at(250, 900, 0);
  assert.deepEqual(w.posted[0].stopped, [2]);
  assert.deepEqual(w.posted[0].failed, ['1: ESRCH', '3: EPERM']);
});

test('only a child process of this app is killed: a reused pid or a core that cannot say is refused; Windows does not ask', () => {
  const kills: any[] = [];
  const kill = (...a: any[]) => kills.push(a);
  killChild(5, { platform: 'darwin', parentOf: () => 100, self: 100, kill });
  assert.deepEqual(kills, [[5, 'SIGKILL']]);
  assert.throws(() => killChild(6, { platform: 'darwin', parentOf: () => 1, self: 100, kill }), /not a process of this app \(parent 1\)/);
  assert.throws(() => killChild(7, { platform: 'linux', parentOf: () => undefined, self: 100, kill }), /\(parent none\)/);
  killChild(8, { platform: 'win32', parentOf: () => assert.fail('not asked on Windows'), self: 100, kill });
  assert.deepEqual(kills.at(-1), [8, 'SIGKILL']);
});

/** No growth needed and no cooldown: the worker stops what it was told of on every tick. */
const EVERY_TICK = { sampleMs: 10, windowMs: 1000, growthBytes: 0, cooldownMs: 0, confirmMs: 0 };

test("the worker's own source runs in a real worker thread and kills the listed child process", async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const gone = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  // the order of the first tick and the list doesn't matter
  const w = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { limits: EVERY_TICK, core: CORE_MODULE },
  });
  try {
    const stopped = new Promise<any>((resolve) => w.on('message', (m) => m.stopped?.length && resolve(m)));
    w.postMessage({ pids: [child.pid] });
    const m = await stopped;
    assert.deepEqual(m.stopped, [child.pid]);
    assert.equal(await gone, 'SIGKILL');
  } finally {
    await w.terminate();
    child.kill('SIGKILL');
  }
});

test("the worker's own source leaves a process that isn't this app's child, and one the core can't place", async () => {
  // sleep's parent is the shell: it is alive and has a parent, but not this process
  const shell = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise<number>((resolve) => shell.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const direct = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const noCore = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'no-core.cjs');
  fs.writeFileSync(noCore, "module.exports = { core: () => null, coreSyncCall: () => { throw new Error('The Rust core is missing.'); } };");
  const run = async (core: string, pid: number) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { limits: EVERY_TICK, core } });
    try {
      const reports: any[] = [];
      const told = new Promise<any>((resolve) => w.on('message', (m) => (reports.push(m), m.ready === undefined && resolve(reports))));
      w.postMessage({ pids: [pid] });
      return await told;
    } finally {
      await w.terminate();
    }
  };
  try {
    const [ready, refused] = await run(CORE_MODULE, grandchild);
    assert.deepEqual(ready, { ready: true }, 'it says it can stop pages before it is asked to');
    assert.deepEqual(refused.stopped, []);
    assert.match(refused.failed[0], new RegExp(`^${grandchild}: not a process of this app \\(parent ${shell.pid}\\)$`));
    const [unready, unknown] = await run(noCore, direct.pid!);
    assert.deepEqual(unready, { ready: false, why: 'The Rust core is missing.' }, 'a worker with no core says so, and why');
    assert.deepEqual(unknown.stopped, []);
    assert.match(unknown.failed[0], /: The Rust core is missing\.$/);
    // both still run
    process.kill(grandchild, 0);
    assert.equal(direct.signalCode, null);
  } finally {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      // gone with its shell
    }
    shell.kill('SIGKILL');
    direct.kill('SIGKILL');
  }
});

/** A webContents stand-in with a renderer process id. */
const page = (pid: number, o: { destroyed?: boolean; throws?: boolean } = {}) => ({
  isDestroyed: () => !!o.destroyed,
  getOSProcessId: () => {
    if (o.throws) throw new Error('no process');
    return pid;
  },
});

function fakeWorker() {
  const w = new EventEmitter() as any;
  w.posted = [] as any[];
  w.postMessage = (m: any) => w.posted.push(m);
  w.unref = mock.fn();
  w.terminate = mock.fn(async () => 0);
  return w;
}

test('the worker says once whether it can stop pages: failing to, or ending or failing first, is logged and told', () => {
  const run = (act: (w: any) => void) => {
    const w = fakeWorker();
    const logs: string[] = [];
    const told: any[] = [];
    const g = new MemoryGuard({
      pages: () => [],
      appContents: () => [],
      makeWorker: () => w,
      every: () => null,
      log: (l: string) => logs.push(l),
      onReady: (p: any) => told.push(p),
    });
    g.start();
    act(w);
    return { told, logs };
  };
  assert.deepEqual(
    run((w) => w.emit('message', { ready: true })),
    { told: [null], logs: [] },
  );
  const unready = run((w) => w.emit('message', { ready: false }));
  assert.deepEqual(unready.told, ['its worker read no process table']);
  const said = run((w) => w.emit('message', { ready: false, why: 'The Rust core is missing.' }));
  assert.deepEqual(said.told, ['its worker read no process table: The Rust core is missing.']);
  assert.match(unready.logs[0], /no page can be stopped: its worker read no process table/);
  assert.deepEqual(run((w) => w.emit('error', new Error('Cannot find module'))).told, ['its worker failed: Cannot find module']);
  assert.deepEqual(run((w) => w.emit('exit')).told, ['its worker ended']);
  // only its first word counts, and a guard with nothing listening says it the same way
  const once = run((w) => {
    w.emit('message', { ready: true });
    w.emit('message', { ready: false });
    w.emit('exit');
  });
  assert.deepEqual(once, { told: [null], logs: [] });
  const w = fakeWorker();
  const quiet = new MemoryGuard({ pages: () => [], appContents: () => [], makeWorker: () => w, every: () => null, log: () => undefined });
  quiet.start();
  w.emit('message', { ready: false });
});

test("main posts the pages' processes, never an app window's, and marks the pages the worker stopped", () => {
  const app = page(10);
  const a = page(20);
  const b = page(20);
  const c = page(30);
  const pages = [a, b, c, page(0), page(40, { destroyed: true }), page(50, { throws: true }), page(10), null];
  const w = fakeWorker();
  const made: any[] = [];
  const timers = new Map<number, () => void>();
  const refresh = () => timers.get(REFRESH_MS)!();
  const lines: string[] = [];
  const marked: any[] = [];
  let usage = { heapTotal: 40 * MB, external: 6 * MB };
  const g = new MemoryGuard({
    onStopped: (wc: any) => marked.push(wc),
    memoryUsage: () => usage,
    pages: () => pages,
    appContents: () => [app],
    makeWorker: (src: string, o: any) => {
      made.push([src, o]);
      return w;
    },
    every: (fn: () => void, ms: number) => {
      timers.set(ms, fn);
      return { unref: mock.fn() };
    },
    log: (line: string) => lines.push(line),
  });
  g.start();
  g.start();
  assert.equal(made.length, 1);
  assert.equal(made[0][0], WORKER_SOURCE);
  assert.deepEqual(made[0][1], { eval: true, workerData: { limits: LIMITS, core: CORE_MODULE } });
  assert.equal(w.unref.mock.callCount(), 1);
  assert.deepEqual([...timers.keys()], [REFRESH_MS, OWN_MS]);
  assert.equal(OWN_MS, LIMITS.sampleMs);
  // the pages' processes, and main's own JS memory (V8 heap and external), from the start
  assert.deepEqual(w.posted, [{ pids: [20, 30] }, { own: 46 * MB }]);
  pages.push(page(60));
  refresh();
  assert.deepEqual(w.posted[2], { pids: [20, 30, 60] });
  usage = { heapTotal: 500 * MB, external: 300 * MB };
  timers.get(OWN_MS)!();
  assert.deepEqual(w.posted[3], { own: 800 * MB });
  w.posted.length = 2;

  // the killed renderer reports no pid any more: the pages are found by the pids last posted
  a.getOSProcessId = () => 0;
  b.getOSProcessId = () => 0;
  w.emit('message', { stopped: [20, 99], fromBytes: 300 * MB, toBytes: 900 * MB, ms: 4_000 });
  assert.deepEqual(marked, [a, b]);
  assert.deepEqual(lines, ['[browser-memory] stopped 2 browser page(s): the main process grew from 300 MB to 900 MB in 4 s']);
  w.emit('message', null);
  assert.match(lines[1], /stopped 0 browser page\(s\): the main process grew from 0 MB to 0 MB in 0 s$/);
  w.emit('message', { stopped: [], failed: ['9: ESRCH'] });
  assert.match(lines[2], /; could not stop 9: ESRCH$/);
  // what main's own work accounted for is said with the stop
  w.emit('message', { stopped: [], fromBytes: 300 * MB, toBytes: 1500 * MB, ownBytes: 600 * MB, ms: 2_000 });
  assert.equal(
    lines[3],
    "[browser-memory] stopped 0 browser page(s): the main process grew from 300 MB to 1500 MB in 2 s (600 MB of it main's own)",
  );

  w.emit('error', new Error('worker failed'));
  g.stop();
  assert.equal(w.terminate.mock.callCount(), 1);
  // an exit after stop() is not ours any more
  w.emit('exit');
  g.stop();
  assert.equal(w.terminate.mock.callCount(), 1);
  g.refresh();
  g.reportOwn();
  assert.equal(w.posted.length, 2);
});

test('a worker that exits on its own ends the guard; a failed terminate is noted, and the defaults log to console.warn', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const w = fakeWorker();
  w.terminate = mock.fn(async () => {
    throw new Error('already gone');
  });
  const g = new MemoryGuard({ pages: () => [], appContents: () => [], makeWorker: () => w, every: () => null });
  g.start();
  w.emit('message', { stopped: [] });
  assert.equal(warn.mock.callCount(), 1);
  // no onStopped: the stop is still logged
  w.emit('message', { stopped: [] });
  w.emit('exit');
  assert.equal(g.worker, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.terminate.mock.callCount(), 1);
});

test('the default worker and timer start and stop for real', async () => {
  const g = new MemoryGuard({ pages: () => [], appContents: () => [] });
  g.start();
  assert.ok(g.worker instanceof Worker);
  assert.ok(g.timer);
  assert.ok(g.ownTimer);
  g.stop();
  assert.equal(g.worker, null);
  assert.equal(g.ownTimer, null);
});

test("the pane's crashed notice says a page was stopped for memory, in either order of crash and report, or by its own renderer", () => {
  const w = browserWorld();
  const manager = new BrowserWindows(w);
  manager.register(w.root);
  const message = () => manager.state(w.root.id, w.host)[0].message;
  w.root.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(message(), 'This page crashed. Reload it to continue.');
  w.root.emit('render-process-gone', {}, { reason: 'oom' });
  assert.equal(message(), MEMORY_MESSAGE);
  w.root.emit('did-start-loading');
  w.root.emit('did-stop-loading');
  // the guard's report first, then the crash (SIGKILL reads as 'killed')
  manager.stoppedForMemory(w.root);
  assert.equal(manager.state(w.root.id, w.host)[0].kind, 'ready');
  w.root.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(message(), MEMORY_MESSAGE);
  // told once: a later crash is an ordinary one
  w.root.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(message(), CRASHED);
  // the crash first, then the report: the shown notice gets the reason, and no mark is left for a later crash
  manager.stoppedForMemory(w.root);
  assert.equal(message(), MEMORY_MESSAGE);
  w.root.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(message(), CRASHED);
  // pages it doesn't track are left alone
  manager.stoppedForMemory({ id: w.root.id });
  manager.stoppedForMemory(null);
  assert.equal(message(), CRASHED);
});

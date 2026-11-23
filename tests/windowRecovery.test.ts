// An app window whose page stops working comes back (electron/platform/windowRecovery.cjs): a gone renderer reloads up to a crash-loop limit, a hung one offers Wait or Reload, a page that didn't load retries once then asks, and every problem is kept and reported with its window named (#4424).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createWindowRecovery,
  ownsAppWindow,
  recentWindowProblems,
  clearWindowProblems,
  RELOADS,
  RELOAD_WINDOW_MS,
  LOAD_RETRY_MS,
  PROBLEMS_KEPT,
  MEMORY_SAMPLE_MS,
} = require('../electron/platform/windowRecovery.cjs');
const ignored = require('../electron/ignored.cjs');

let nextId = 1;
class FakeContents extends EventEmitter {
  id = nextId++;
  destroyed = false;
  pid = 4000 + this.id;
  reloads = 0;
  crashes = 0;
  isDestroyed = () => this.destroyed;
  getOSProcessId = () => this.pid;
  reload() {
    this.reloads++;
  }
  forcefullyCrashRenderer() {
    this.crashes++;
  }
}
class FakeWindow {
  static fail: Error | null = null;
  destroyed = false;
  webContents = new FakeContents();
  loads: any[][] = [];
  isDestroyed = () => this.destroyed;
  load(...a: any[]) {
    this.loads.push(a);
    return FakeWindow.fail ? Promise.reject(FakeWindow.fail) : Promise.resolve();
  }
  loadFile(...a: any[]) {
    return this.load('file', ...a);
  }
  loadURL(...a: any[]) {
    return this.load('url', ...a);
  }
}

/** A recovery with a clock, timers, a dialog whose answers the test gives, and the reports it sent. */
function setup(o: { metrics?: () => any[]; unref?: boolean; isDev?: boolean; electron?: boolean } = {}) {
  clearWindowProblems();
  FakeWindow.fail = null;
  let clock = 1_000_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number; unref?: boolean }[] = [];
  const asked: { win: any; o: any; answer: (r: number) => void; fail: (e: Error) => void }[] = [];
  const reports: any[] = [];
  const state = { quitting: false, quits: 0, telemetry: true };
  const recovery = createWindowRecovery({
    page: '/app/dist/index.html',
    isDev: !!o.isDev,
    // left out: Electron's own (which a unit test's require('electron') doesn't have)
    app: o.electron ? undefined : { quit: () => state.quits++, getAppMetrics: o.metrics ?? (() => []) },
    dialog: o.electron
      ? undefined
      : {
          showMessageBox: (win: any, opts: any) =>
            new Promise((resolve, reject) => {
              const entry = { win, o: opts, answer: (response: number) => resolve({ response }), fail: reject };
              asked.push(entry);
              opts.signal?.addEventListener('abort', () => resolve({ response: opts.cancelId }));
            }),
        },
    telemetry: () => (state.telemetry ? { error: (e: any) => reports.push(e) } : null),
    quitting: () => state.quitting,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    every: (fn: () => void, ms: number) => {
      const entry: any = { fn, ms };
      intervals.push(entry);
      return o.unref === false ? {} : Object.assign(entry, { unref: () => (entry.unref = true) });
    },
  });
  return {
    recovery,
    timers,
    intervals,
    asked,
    reports,
    state,
    tick: (ms: number) => (clock += ms),
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

function attached(s: ReturnType<typeof setup>, kind: 'main' | 'quick' = 'main', hash?: string) {
  const win = new FakeWindow();
  s.recovery.attach(win, kind, hash);
  return { win, wc: win.webContents, loads: win.loads };
}

test('a gone renderer reloads, up to the crash-loop limit; past it the user chooses Reload or Quit', async () => {
  const s = setup();
  const { win, wc } = attached(s);
  assert.equal(ownsAppWindow(wc), true);
  assert.equal(ownsAppWindow(new FakeContents()), false);

  // a clean exit (the window closing) is not a problem
  wc.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  assert.equal(wc.reloads, 0);

  for (let i = 0; i < RELOADS; i++) wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  assert.equal(wc.reloads, RELOADS);
  assert.equal(s.asked.length, 0);

  // one more within the window: a loop, so the user is asked
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  assert.equal(wc.reloads, RELOADS);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].win, win);
  assert.deepEqual(s.asked[0].o.buttons, ['Reload', 'Quit']);
  s.asked[0].answer(0);
  await s.settle();
  assert.equal(wc.reloads, RELOADS + 1, 'Reload reloads');

  // Reload started the count again: the next ones reload on their own
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  assert.equal(wc.reloads, RELOADS + 2);
  for (let i = 1; i < RELOADS; i++) wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  assert.equal(s.asked.length, 2);
  s.asked[1].answer(1);
  await s.settle();
  assert.equal(s.state.quits, 1, 'Quit quits');

  // a question that failed to show (or was dismissed another way) does neither
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  s.asked[2].fail(new Error('no dialog'));
  await s.settle();
  assert.equal(s.state.quits, 1);

  // reports name the window and the problem; the exit code is part of the message
  assert.equal(s.reports[0].message, 'app window renderer gone: oom (5)');
  assert.equal(s.reports[0].component, 'main');
  assert.equal(s.reports[0].kind, 'window-problem');
  assert.equal(s.reports[0].process, 'renderer');
});

test('crashes spread out over time keep reloading on their own', () => {
  const s = setup();
  const { wc } = attached(s);
  for (let i = 0; i < RELOADS * 3; i++) {
    wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
    s.tick(RELOAD_WINDOW_MS / RELOADS + 1);
  }
  assert.equal(wc.reloads, RELOADS * 3);
  assert.equal(s.asked.length, 0);
});

test('nothing is reloaded or asked while the app quits or once the window is closed', async () => {
  const s = setup();
  const { win, wc } = attached(s);
  s.state.quitting = true;
  wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 15 });
  wc.emit('unresponsive');
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  assert.equal(wc.reloads, 0);
  assert.equal(s.asked.length, 0);
  assert.equal(s.timers.length, 0);
  assert.equal(s.reports.length, 0);
  s.state.quitting = false;
  win.destroyed = true;
  wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 15 });
  assert.equal(wc.reloads, 0);

  // a window closed while the crash-loop question is open is not reloaded by Reload
  const b = attached(s);
  for (let i = 0; i <= RELOADS; i++) b.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  b.win.destroyed = true;
  s.asked.at(-1)!.answer(0);
  await s.settle();
  assert.equal(b.wc.reloads, RELOADS);
});

test('a hung window offers Wait or Reload; Reload stops its renderer and loads it again without counting as a crash', async () => {
  const s = setup();
  const { win, wc } = attached(s, 'quick');
  wc.emit('unresponsive');
  // one question at a time
  wc.emit('unresponsive');
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].win, win);
  assert.deepEqual(s.asked[0].o.buttons, ['Wait', 'Reload']);
  assert.ok(s.asked[0].o.signal instanceof AbortSignal);
  assert.equal(s.reports[0].message, 'Quick Chat not responding');

  // Wait leaves it alone
  s.asked[0].answer(0);
  await s.settle();
  assert.equal(wc.crashes, 0);

  // Reload stops the renderer, and the renderer it leaves behind is loaded again
  wc.emit('unresponsive');
  s.asked[1].answer(1);
  await s.settle();
  assert.equal(wc.crashes, 1);
  wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
  assert.equal(wc.reloads, 1);
  assert.equal(s.reports.at(-1).message, 'Quick Chat reloaded while not responding (9)');

  // that one did not count toward the crash loop: RELOADS more crashes still reload on their own
  for (let i = 0; i < RELOADS; i++) wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(wc.reloads, 1 + RELOADS);
  assert.equal(s.asked.length, 2);
});

test('the hang question closes when the window responds or its renderer goes, and then does nothing', async () => {
  const s = setup();
  const { win, wc } = attached(s);
  // responding with no question open is fine
  wc.emit('responsive');
  wc.emit('unresponsive');
  const first = s.asked[0].o.signal as AbortSignal;
  wc.emit('responsive');
  assert.equal(first.aborted, true);
  await s.settle();
  assert.equal(wc.crashes, 0);

  // a renderer gone while asking closes the question too (and reloads as a crash)
  wc.emit('unresponsive');
  const second = s.asked[1];
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(second.o.signal.aborted, true);
  assert.equal(wc.reloads, 1);

  // an answer that arrives after the question was replaced is ignored
  wc.emit('unresponsive');
  const third = s.asked[2];
  wc.emit('responsive');
  third.answer(1);
  await s.settle();
  assert.equal(wc.crashes, 0);

  // Reload chosen once the window closed does nothing
  wc.emit('unresponsive');
  win.destroyed = true;
  s.asked[3].answer(1);
  await s.settle();
  assert.equal(wc.crashes, 0);
});

test('a page that did not load is tried again once, then the user chooses Try again or Quit', async () => {
  const s = setup();
  const { win, wc, loads } = attached(s);
  // a frame's failure or a cancelled navigation is not the window's
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', false);
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x', true);
  assert.equal(s.timers.length, 0);

  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, LOAD_RETRY_MS);
  s.timers[0].fn();
  assert.equal(loads.length, 2);
  assert.equal(s.reports[0].message, "app window didn't load: ERR_FILE_NOT_FOUND (-6)");

  // the retry failed too: ask
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  assert.equal(s.timers.length, 1);
  assert.deepEqual(s.asked[0].o.buttons, ['Try again', 'Quit']);
  assert.match(s.asked[0].o.detail, /^ERR_FILE_NOT_FOUND\. /);
  s.asked[0].answer(0);
  await s.settle();
  assert.equal(loads.length, 3);

  wc.emit('did-fail-load', {}, -2, '', 'file:///x', true);
  assert.equal(s.reports.at(-1).message, "app window didn't load: unknown error (-2)");
  assert.match(s.asked[1].o.detail, /^The page didn’t load\. /);
  s.asked[1].answer(1);
  await s.settle();
  assert.equal(s.state.quits, 1);

  // dismissed, or Try again once the window closed: nothing
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///x', true);
  // a failure while that question is open asks nothing more
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///x', true);
  assert.equal(s.asked.length, 3);
  s.asked[2].answer(-1);
  await s.settle();
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///x', true);
  win.destroyed = true;
  s.asked[3].answer(0);
  await s.settle();
  assert.equal(loads.length, 3);
  assert.equal(s.state.quits, 1);
});

test('the retry of a page that did not load waits for nothing once the window closed', () => {
  const s = setup();
  const { win, wc, loads } = attached(s);
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  win.destroyed = true;
  s.timers[0].fn();
  assert.equal(loads.length, 1);
});

test("each app window's renderer memory is sampled, and a problem carries the last figure", () => {
  const metrics: any[] = [];
  let fail = false;
  const s = setup({
    metrics: () => {
      if (fail) throw new Error('metrics unavailable');
      return metrics;
    },
  });
  const a = attached(s);
  const b = attached(s);
  const gone = attached(s);
  // one sampler for every window, not keeping the app alive
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].ms, MEMORY_SAMPLE_MS);
  assert.equal(s.intervals[0].unref, true);

  metrics.push({ pid: a.wc.pid, memory: { workingSetSize: 812 * 1024 } }, { pid: gone.wc.pid, memory: { workingSetSize: 1024 } });
  gone.wc.destroyed = true;
  s.intervals[0].fn();
  a.wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  b.wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  assert.equal(s.reports[0].stack, 'memory: 812 MB');
  assert.equal(s.reports[1].stack, '', 'b had no figure');
  const [ra, rb] = recentWindowProblems();
  assert.equal(ra.memoryMB, 812);
  assert.equal('memoryMB' in rb, false);

  // a closed window's figure goes with it
  a.wc.emit('destroyed');
  a.wc.destroyed = true;
  s.intervals[0].fn();

  // a failed read is noted and leaves the last figures
  const before = ignored.recentIgnored().length;
  fail = true;
  s.intervals[0].fn();
  assert.ok(ignored.recentIgnored().some((e: any) => e.message === 'metrics unavailable'));
  assert.ok(ignored.recentIgnored().length >= before);
});

test('a sampler without unref is used as it is', () => {
  const s = setup({ unref: false });
  attached(s);
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].unref, undefined);
});

test('the latest problems are kept, oldest first, as copies, and reported only while telemetry is up', () => {
  const s = setup();
  const { wc } = attached(s);
  s.state.telemetry = false;
  wc.emit('unresponsive');
  assert.equal(s.reports.length, 0);
  assert.equal(recentWindowProblems()[0].problem, 'not responding');
  assert.equal('exitCode' in recentWindowProblems()[0], false);
  s.state.telemetry = true;
  for (let i = 0; i < PROBLEMS_KEPT + 2; i++) {
    s.tick(RELOAD_WINDOW_MS);
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: i });
  }
  const recent = recentWindowProblems();
  assert.equal(recent.length, PROBLEMS_KEPT);
  assert.equal(recent[0].exitCode, 2);
  assert.equal(recent.at(-1).exitCode, PROBLEMS_KEPT + 1);
  assert.equal(recent[0].window, 'app window');
  recent[0].problem = 'changed';
  assert.notEqual(recentWindowProblems()[0].problem, 'changed');
});

test("attaching loads the window's page: the built page with its hash, or the dev server's; a load's rejection is noted", async () => {
  const s = setup();
  assert.deepEqual(attached(s, 'main', 'thread=a').loads, [['file', '/app/dist/index.html', { hash: 'thread=a' }]]);
  assert.deepEqual(attached(s).loads, [['file', '/app/dist/index.html', undefined]]);
  // a retry loads the same page
  const { wc, loads } = attached(s, 'quick', 'mini');
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  s.timers[0].fn();
  assert.deepEqual(loads, [
    ['file', '/app/dist/index.html', { hash: 'mini' }],
    ['file', '/app/dist/index.html', { hash: 'mini' }],
  ]);

  FakeWindow.fail = new Error('ERR_FAILED');
  attached(s);
  await s.settle();
  assert.ok(ignored.recentIgnored().some((e: any) => e.context === 'load an app window' && e.message === 'ERR_FAILED'));

  const before = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173/';
  try {
    const dev = setup({ isDev: true });
    assert.deepEqual(attached(dev, 'main', 'thread=b').loads, [['url', 'http://localhost:5173/#thread=b']]);
    assert.deepEqual(attached(dev).loads, [['url', 'http://localhost:5173/']]);
  } finally {
    if (before === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = before;
  }
});

test("without app and dialog given, Electron's own are used: one that fails is noted, and nothing else happens", async () => {
  const s = setup({ electron: true });
  const { wc } = attached(s);
  s.intervals[0].fn();
  assert.ok(ignored.recentIgnored().some((e: any) => e.context === "read the app windows' memory"));
  wc.emit('unresponsive');
  await s.settle();
  assert.ok(ignored.recentIgnored().some((e: any) => e.context === 'ask about a window that stopped working'));
  assert.equal(wc.crashes, 0);
});

test('a page that loads starts its retry over; in development the question points at the dev server', async () => {
  const s = setup({ isDev: true });
  const { wc, loads } = attached(s);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true);
  s.timers[0].fn();
  wc.emit('did-finish-load');
  // much later the page fails again: it is retried on its own first, not asked about
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true);
  assert.equal(s.timers.length, 2);
  assert.equal(s.asked.length, 0);
  s.timers[1].fn();
  assert.equal(loads.length, 3);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true);
  assert.equal(s.asked[0].o.detail, 'ERR_CONNECTION_REFUSED. Check that the dev server is running.');
});

test('one question at a time: a crash loop while a load question is open asks nothing more', async () => {
  const s = setup();
  const { wc } = attached(s);
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
  assert.equal(s.asked.length, 1);
  for (let i = 0; i <= RELOADS; i++) wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(s.asked.length, 1);
  s.asked[0].answer(-1);
  await s.settle();
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(s.asked.length, 2);
  assert.deepEqual(s.asked[1].o.buttons, ['Reload', 'Quit']);
});

test('Reload on a hang whose renderer never went is forgotten once the page starts over', async () => {
  const s = setup();
  const { wc } = attached(s);
  wc.emit('unresponsive');
  s.asked[0].answer(1);
  await s.settle();
  assert.equal(wc.crashes, 1);
  // no render-process-gone came; the user reloads, and a later crash is an ordinary one
  wc.emit('did-start-loading');
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  assert.equal(recentWindowProblems().at(-1).problem, 'renderer gone: crashed');
});

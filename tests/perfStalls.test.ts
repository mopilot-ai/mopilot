// The always-on main-process stall logger (electron/perf/stalls.cjs): lateness math, the stall line, sleep suppression,
// nested labels for the last long synchronous task, and the bounded rotated log file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import diagnostics from 'node:diagnostics_channel';

const require = createRequire(import.meta.url);
const stalls = require('../electron/perf/stalls.cjs');

const visibleWindow = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };

/** A clock, timer and power monitor that move only when the test says. */
function rig(opts: { focused?: boolean; windows?: any[]; rss?: () => number } = {}) {
  let clock = 1000;
  let tick: () => void = () => undefined;
  const handlers = new Map<string, () => void>();
  const lines: string[] = [];
  const warns: string[] = [];
  const log: string[] = [];
  const timer = { unref: () => void log.push('unref') };
  const electron = {
    BrowserWindow: {
      getAllWindows: () => opts.windows ?? [visibleWindow],
      getFocusedWindow: () => (opts.focused === false ? null : {}),
    },
    powerMonitor: {
      on: (e: string, cb: () => void) => handlers.set(e, cb),
      removeListener: (e: string, cb: () => void) => void (handlers.get(e) === cb && handlers.delete(e)),
    },
  };
  const logger = stalls.startStallLogger({
    dir: '/unused',
    electron,
    now: () => 777,
    clock: () => clock,
    setInterval: (cb: () => void, ms: number) => (assert.equal(ms, stalls.INTERVAL_MS), (tick = cb), timer),
    clearInterval: (t: unknown) => void log.push(t === timer ? 'cleared' : 'wrong'),
    rss: opts.rss ?? (() => 123456),
    log: { append: (l: string) => void lines.push(l) },
    warn: (m: string) => warns.push(m),
  });
  return {
    logger,
    lines,
    warns,
    log,
    handlers,
    advance(ms: number) {
      clock += ms;
      tick();
    },
    move: (ms: number) => void (clock += ms),
    stalls: () => lines.map((l) => JSON.parse(l)),
  };
}

test('lateness is the time beyond the period, never negative', () => {
  assert.equal(stalls.lateness(0, 200), 0);
  assert.equal(stalls.lateness(0, 150), 0);
  assert.equal(stalls.lateness(0, 1200), 1000);
  assert.equal(stalls.lateness(0, 400, 100), 300);
});

test('a timer on time or slightly late is no stall; one more than 500 ms late is logged with its context', () => {
  const r = rig();
  r.advance(200);
  r.advance(700);
  assert.equal(r.lines.length, 0, '500 ms late exactly is not past the threshold');
  r.advance(701);
  assert.deepEqual(r.stalls(), [
    {
      t: 777,
      kind: 'stall',
      ms: 501,
      focused: true,
      visible: true,
      rss: 123456,
      rssDelta: 0,
      ipc: [],
      tasks: [],
      spawns: 0,
      label: null,
      labelMs: null,
    },
  ]);
  assert.match(r.warns[0], /stalled 501 ms$/);
  r.advance(1700);
  assert.deepEqual(r.logger.stats(), { count: 2, maxMs: 1500 });
  assert.equal(r.log[0], 'unref');
});

test('window state: blurred, hidden, minimized and destroyed windows are not on screen', () => {
  const gone = [
    { ...visibleWindow, isDestroyed: () => true },
    { ...visibleWindow, isVisible: () => false },
    { ...visibleWindow, isMinimized: () => true },
  ];
  const r = rig({ focused: false, windows: gone });
  r.advance(1500);
  assert.equal(r.stalls()[0].focused, false);
  assert.equal(r.stalls()[0].visible, false);
});

test('a sleep and wake is not a stall, and the timer is measured again after the first tick', () => {
  const r = rig();
  r.handlers.get('suspend')!();
  r.move(60_000);
  r.handlers.get('resume')!();
  r.advance(5000);
  assert.equal(r.lines.length, 0);
  r.advance(1000);
  assert.equal(r.lines.length, 1);
  // a wake alone is suppressed too
  r.handlers.get('resume')!();
  r.advance(9000);
  assert.equal(r.lines.length, 1);
});

test('stop clears the timer and the power listeners', () => {
  const r = rig();
  r.logger.stop();
  assert.deepEqual(r.log, ['unref', 'cleared']);
  assert.equal(r.handlers.size, 0);
});

test('a stall names the last long labeled task, nested labels as a path, and not a task from before the previous tick', () => {
  const r = rig();
  const out = stalls.labeled('outer', () => {
    stalls.labeled('short', () => r.move(10));
    stalls.labeled('inner', () => r.move(900));
    return 'value';
  });
  assert.equal(out, 'value');
  r.advance(0);
  assert.deepEqual(
    r.stalls().map((s: any) => [s.label, s.labelMs]),
    [['outer>inner', 900]],
  );
  // a later task replaces it; a thrown one still counts and rethrows
  assert.throws(
    () =>
      stalls.labeled('boom', () => {
        r.move(800);
        throw new Error('x');
      }),
    /x/,
  );
  r.advance(0);
  assert.equal(r.stalls()[1].label, 'boom');
  // a long task that finished before the previous tick is not blamed
  r.advance(1000);
  assert.equal(r.stalls()[2].label, null);
});

test('labels run without a logger, and a short task leaves no label', () => {
  assert.equal(
    stalls.labeled('plain', () => 5),
    5,
  );
  const r = rig();
  stalls.labeled('quick', () => r.move(49));
  r.advance(1000);
  assert.equal(r.stalls()[0].label, null);
});

function fakeFsp(initial: number | null = null) {
  const calls: string[] = [];
  let size = initial;
  const fsp = {
    mkdir: async (d: string) => void calls.push(`mkdir ${path.basename(d)}`),
    stat: async () => {
      calls.push('stat');
      if (size === null) throw new Error('ENOENT');
      return { size };
    },
    rename: async (a: string, b: string) => {
      calls.push(`rename ${path.basename(a)} ${path.basename(b)}`);
      size = null;
    },
    appendFile: async (f: string, text: string) => {
      calls.push(`append ${path.basename(f)} ${text.length}`);
      size = (size ?? 0) + text.length;
    },
  };
  return { fsp: fsp as any, calls };
}

test('the log is created, appended in order, and rotated once at its bound', async () => {
  const { fsp, calls } = fakeFsp();
  const log = stalls.createBoundedLog('/x/perf/stalls.jsonl', { max: 30, fsp });
  void log.append('a'.repeat(9));
  void log.append('b'.repeat(9));
  await log.append('c'.repeat(9));
  await log.append('d'.repeat(9));
  assert.deepEqual(
    calls.filter((c) => !c.startsWith('mkdir')),
    [
      'stat',
      'append stalls.jsonl 10',
      'append stalls.jsonl 10',
      'append stalls.jsonl 10',
      'rename stalls.jsonl stalls.1.jsonl',
      'append stalls.jsonl 10',
    ],
  );
});

test('an existing log starts from its size, and a failing disk is warned about without breaking later lines', async () => {
  const existing = fakeFsp(100);
  await stalls.createBoundedLog('/x/stalls.jsonl', { max: 50, fsp: existing.fsp }).append('z');
  assert.ok(existing.calls.includes('rename stalls.jsonl stalls.1.jsonl'));
  const bad = fakeFsp();
  let fail = true;
  bad.fsp.appendFile = async () => {
    if (fail) throw new Error('disk full');
  };
  const warned: unknown[][] = [];
  const log = stalls.createBoundedLog('/x/stalls.jsonl', { fsp: bad.fsp, warn: (...a: unknown[]) => void warned.push(a) });
  await log.append('one');
  fail = false;
  await log.append('two');
  assert.match(String(warned[0]?.[0]), /could not write the stall log/);
  assert.equal(warned.length, 1);
});

test('on disk the log is created under perf and holds at most the current and one rotated file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-stalls-'));
  const file = path.join(dir, 'perf', 'stalls.jsonl');
  const log = stalls.createBoundedLog(file, { max: 20 });
  await log.append(JSON.stringify({ a: 1 }));
  await log.append(JSON.stringify({ a: 2, pad: 'xxxxxxxxxxxxxxxx' }));
  await log.append(JSON.stringify({ a: 3 }));
  assert.equal(fs.readFileSync(file, 'utf8').trim(), '{"a":3}');
  assert.match(fs.readFileSync(path.join(dir, 'perf', 'stalls.1.jsonl'), 'utf8'), /"a":2/);
});

test('the logger defaults to the real clock, timer, rss, log file and console', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-stalls-'));
  const electron = {
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    powerMonitor: { on() {}, removeListener() {} },
  };
  const lines: string[] = [];
  let tick: () => void = () => undefined;
  let clock = 0;
  const logger = stalls.startStallLogger({
    dir,
    electron,
    clock: () => clock,
    setInterval: (cb: () => void) => ((tick = cb), {}),
    clearInterval: () => undefined,
    log: { append: (l: string) => void lines.push(l) },
    warn: () => undefined,
  });
  clock = 3000;
  tick();
  logger.stop();
  assert.ok(JSON.parse(lines[0]).rss > 0);
  assert.deepEqual(logger.stats(), { count: 1, maxMs: 2800 });
  const real = stalls.startStallLogger({ dir, electron });
  real.stop();
});

test('an app without a power monitor, or whose windows cannot be read, still logs the stall', () => {
  const warned: string[] = [];
  const lines: string[] = [];
  let tick: () => void = () => undefined;
  let clock = 0;
  const logger = stalls.startStallLogger({
    dir: '/unused',
    electron: {
      BrowserWindow: {
        getAllWindows: () => {
          throw new Error('no windows');
        },
      },
    },
    clock: () => clock,
    setInterval: (cb: () => void) => ((tick = cb), {}),
    clearInterval: () => undefined,
    log: { append: (l: string) => void lines.push(l) },
    warn: (m: string) => void warned.push(m),
  });
  clock = 2000;
  tick();
  logger.stop();
  assert.deepEqual([JSON.parse(lines[0]).focused, JSON.parse(lines[0]).visible], [false, false]);
  assert.ok(warned.some((m) => /could not read the window state/.test(m)));
});

test('without an electron dependency the logger reads Electron itself and still logs outside the app', () => {
  // under node:test require('electron') is the npm package's path string, with no windows or power monitor to read
  const lines: string[] = [];
  const warned: string[] = [];
  let tick: () => void = () => undefined;
  let clock = 0;
  const logger = stalls.startStallLogger({
    dir: '/unused',
    clock: () => clock,
    setInterval: (cb: () => void) => ((tick = cb), {}),
    clearInterval: () => undefined,
    log: { append: (l: string) => void lines.push(l) },
    warn: (m: string) => void warned.push(m),
  });
  clock = 2000;
  tick();
  logger.stop();
  assert.equal(JSON.parse(lines[0]).kind, 'stall');
  assert.deepEqual([JSON.parse(lines[0]).focused, JSON.parse(lines[0]).visible], [false, false]);
});

test('a stall names the IPC calls and long tasks inside it, the rss growth since the last tick and the processes started', () => {
  let bytes = 1000;
  const r = rig({ rss: () => bytes });
  r.advance(200);
  // before the previous tick: not part of this stall
  stalls.noteIpc('old:call');
  r.advance(200);
  stalls.noteIpc('chat:open');
  stalls.noteIpc('chat:open');
  stalls.noteIpc('peer:referenceHistory');
  stalls.labeled('a', () => r.move(60));
  stalls.labeled('b', () => r.move(70));
  diagnostics.channel('child_process').publish({ process: {} });
  bytes = 5000;
  r.advance(1500);
  const [line] = r.stalls();
  assert.deepEqual(line.ipc, [
    { channel: 'chat:open', n: 2 },
    { channel: 'peer:referenceHistory', n: 1 },
  ]);
  assert.deepEqual(line.tasks, [
    { label: 'b', ms: 70 },
    { label: 'a', ms: 60 },
  ]);
  assert.equal(line.rssDelta, 4000);
  assert.equal(line.spawns, 1);
  // the next stall starts counting again
  r.advance(1500);
  assert.equal(r.stalls()[1].spawns, 0);
  assert.deepEqual(r.stalls()[1].ipc, []);
  r.logger.stop();
  diagnostics.channel('child_process').publish({ process: {} });
});

test('the rings keep the most recent RING calls and tasks, and a line names at most LINE_MAX of them', () => {
  const r = rig();
  r.advance(200);
  for (let i = 0; i < stalls.RING + 5; i++) stalls.noteIpc(`c${i}`);
  for (let i = 0; i < stalls.RING + 5; i++) stalls.labeled(`t${i}`, () => r.move(51));
  r.advance(1000);
  const [line] = r.stalls();
  assert.equal(line.ipc.length, stalls.LINE_MAX);
  assert.equal(line.tasks.length, stalls.LINE_MAX);
  assert.equal(line.tasks[0].label, `t${stalls.RING + 4}`);
});

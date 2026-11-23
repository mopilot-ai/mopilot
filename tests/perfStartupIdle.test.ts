// Phase 0's probes (docs/architecture/rust-core.md §2): the startup timeline (electron/perf/startup.cjs), written by the
// probe as `mark` samples with the windows' marks put on main's timeline, and the idle samples every IDLE_TICKS: each
// process's RSS, CPU and wakeups, main's CPU time and the child processes started meanwhile.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startup = require('../electron/perf/startup.cjs');
const probe = require('../electron/perf/probe.cjs');

function fakeTimers() {
  const t = {
    cb: null as null | (() => void),
    setInterval: ((cb: () => void) => ((t.cb = cb), { unref: () => undefined })) as any,
    clearInterval: (() => undefined) as any,
  };
  return t;
}
const monitor = () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 10_000_000, max: 10_000_000 });
const recorder = () => {
  const pushed: any[] = [];
  return {
    pushed,
    writer: {
      push: (l: string) => (pushed.push(JSON.parse(l)), true),
      takeDropped: () => 0,
      flush: async () => undefined,
      drain: async () => undefined,
    },
  };
};

test('the startup timeline keeps each mark once, in order, up to its bound, and tells a listener', (t) => {
  startup.resetStartupMarks();
  t.after(() => startup.resetStartupMarks());
  const heard: any[] = [];
  const stop = startup.onStartupMark((m: any) => heard.push(m));
  startup.markStartup('whenReady', 12.345, 40);
  startup.markStartup('whenReady', 99, 41);
  startup.markStartup('appReady');
  assert.deepEqual(startup.startupMarks()[0], { name: 'whenReady', ms: 12.35, modules: 40 });
  assert.equal(startup.startupMarks()[1].name, 'appReady');
  assert.ok(startup.startupMarks()[1].ms > 0);
  // by default, the CommonJS modules this process has loaded: a count no runner's speed changes
  assert.equal(startup.startupMarks()[1].modules, Object.keys(require.cache).length);
  assert.equal(heard.length, 2);
  // a copy: changing it changes nothing
  startup.startupMarks()[0].ms = 0;
  assert.equal(startup.startupMarks()[0].ms, 12.35);
  stop();
  // a stop that is no longer the listener leaves the current one alone
  const later: any[] = [];
  startup.onStartupMark((m: any) => later.push(m));
  stop();
  for (let i = 0; i < startup.MAX_MARKS; i++) startup.markStartup(`m${i}`, i);
  assert.equal(startup.startupMarks().length, startup.MAX_MARKS);
  assert.equal(heard.length, 2);
  assert.equal(later.length, startup.MAX_MARKS - 2);
  assert.equal(startup.sinceStart(1500.5, 1000), 500.5);
  assert.equal(typeof startup.sinceStart(Date.now()), 'number');
});

test("the modules main loaded are counted by package, the app's own files by folder, heaviest first, once per name", (t) => {
  startup.resetStartupMarks();
  t.after(() => startup.resetStartupMarks());
  const files = [
    '/a/electron/main.cjs',
    '/a/electron/app/startup.cjs',
    '/a/electron/app/deep/more/x.cjs',
    '/a/package.json',
    '/b/elsewhere.js',
    '/a/node_modules/zod/index.js',
    '/a/node_modules/@scope/pkg/lib/a.js',
    '/a/node_modules/@scope/pkg/lib/b.js',
    '/a/node_modules/@scope/pkg/lib/c.js',
    '/a/node_modules/outer/node_modules/inner/x.js',
    'C:\\a\\node_modules\\win\\v.js',
  ];
  assert.deepEqual(Object.entries(startup.packagesOf(files, '/a')), [
    ['@scope/pkg', 3],
    ['./electron/app', 2],
    ['./electron', 1],
    ['./', 1],
    ['other', 1],
    ['zod', 1],
    ['inner', 1],
    ['win', 1],
  ]);
  startup.markModules('whenReady', ['/x/node_modules/zod/a.js', '/x/node_modules/zod/b.js']);
  startup.markModules('whenReady', []);
  const [b] = startup.moduleBreakdowns();
  assert.equal(startup.moduleBreakdowns().length, 1);
  assert.equal(b.packages.zod, 2);
  // a copy: changing it changes nothing
  b.packages.zod = 0;
  assert.equal(startup.moduleBreakdowns()[0].packages.zod, 2);
  // by default, this process's own loaded modules
  startup.markModules('now');
  const now = startup.moduleBreakdowns()[1].packages;
  // this module's own folder, counted from the default root
  assert.ok(now['./electron/perf'] >= 1);
  assert.equal(
    Object.values(now).reduce((n: number, c: any) => n + c, 0),
    Object.keys(require.cache).length,
  );
});

test('the probe writes the marks so far at once, each later one as it comes, and stops hearing them', async () => {
  const { pushed, writer } = recorder();
  let stopped = 0;
  let listener: any = null;
  const spawns = { take: () => ({ count: 0, commands: {} }), stop: () => void stopped++ };
  const p = probe.createProbe({
    file: '/x.jsonl',
    now: () => 7,
    monitor,
    writer,
    ...fakeTimers(),
    spawns,
    marks: () => [{ name: 'whenReady', ms: 40 }],
    onMark: (fn: any) => ((listener = fn), () => void (listener = null)),
    breakdowns: () => [{ name: 'whenReady', packages: { app: 3, zod: 1 } }],
    requires: () => ({ files: 2, ms: 5, slowest: [{ file: 'a.cjs', ms: 4 }] }),
  });
  listener({ name: 'appReady', ms: 900 });
  assert.deepEqual(pushed, [
    { t: 7, kind: 'mark', name: 'whenReady', ms: 40 },
    { t: 7, kind: 'modules', name: 'whenReady', packages: { app: 3, zod: 1 } },
    { t: 7, kind: 'requires', files: 2, ms: 5, slowest: [{ file: 'a.cjs', ms: 4 }] },
    { t: 7, kind: 'mark', name: 'appReady', ms: 900 },
  ]);
  await p.stop();
  assert.equal(listener, null);
  assert.equal(stopped, 1);
});

test('every IDLE_TICKS the probe samples each process, main’s CPU time and the spawns since the last time', async () => {
  const { pushed, writer } = recorder();
  const timers = fakeTimers();
  let spawned = 3;
  const p = probe.createProbe({
    file: '/x.jsonl',
    now: () => 1,
    monitor,
    writer,
    ...timers,
    marks: () => [],
    onMark: () => () => undefined,
    metrics: () => [
      { type: 'Browser', pid: 1, memory: { workingSetSize: 200_000 }, cpu: { percentCPUUsage: 0.4, idleWakeupsPerSecond: 3 } },
      { type: 'GPU', pid: 2 },
    ],
    cpuUsage: () => ({ user: 1_500_400, system: 250_600 }),
    spawns: {
      take: () => {
        const n = spawned;
        spawned = 0;
        return { count: n, commands: { ps: n } };
      },
      stop: () => undefined,
    },
  });
  for (let i = 1; i < probe.IDLE_TICKS; i++) timers.cb!();
  assert.equal(pushed.filter((s) => s.kind === 'proc').length, 0);
  timers.cb!();
  assert.deepEqual(
    pushed.filter((s) => ['proc', 'cpu', 'spawns'].includes(s.kind)),
    [
      { t: 1, kind: 'proc', type: 'Browser', pid: 1, rssKb: 200_000, cpuPct: 0.4, wakeups: 3 },
      { t: 1, kind: 'proc', type: 'GPU', pid: 2, rssKb: null, cpuPct: null, wakeups: null },
      { t: 1, kind: 'cpu', userMs: 1500, systemMs: 251 },
      { t: 1, kind: 'spawns', count: 3, commands: { ps: 3 } },
    ],
  );
  await p.stop();
});

test('countSpawns counts the child processes Node publishes, names each once it started, and stops when told', async () => {
  const counter = probe.countSpawns();
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  // one that fails to start is counted, not named
  const missing = spawn('/no/such/program');
  await new Promise((r) => missing.on('error', r));
  // named by its program and first word that is not an option (`node -e 0`)
  const first = counter.take();
  assert.deepEqual([first.count, first.commands], [2, { [`${path.basename(process.execPath)} 0`]: 1 }]);
  // where it was spawned: this test file's spawn() call, named from the root
  assert.match(Object.keys(first.sites)[0], /^node 0 @ .*tests\/perfStartupIdle\.test\.ts:\d+/);
  assert.deepEqual(counter.take(), { count: 0, commands: {}, sites: {} });
  counter.stop();
  const again = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => again.on('exit', r));
  assert.deepEqual(counter.take(), { count: 0, commands: {}, sites: {} });
  // the channel it is given: a message without a process is counted
  const subs: any[] = [];
  const c = probe.countSpawns(
    { subscribe: (_n: string, fn: any) => subs.push(fn), unsubscribe: () => undefined },
    () => 'Error\n    at node:internal/x:1:1',
  );
  subs[0]();
  // a child with no program named reads as '?'
  let started: (() => void) | null = null;
  subs[0]({ process: { once: (_e: string, fn: () => void) => (started = fn) } });
  started!();
  assert.deepEqual(c.take(), { count: 2, commands: { '?': 1 }, sites: { '? @ ?': 1 } });
});

test("a spawn's caller is its app frames nearest the spawn, up to three, past Node's, packages' and the probe's own", () => {
  const stack = [
    'Error',
    '    at countSpawns.heard (/r/electron/perf/probe.cjs:50:19)',
    '    at Channel.publish (node:diagnostics_channel:1:1)',
    '    at spawn (node:child_process:2:2)',
    '    at execFile (/r/node_modules/cross-spawn/index.js:3:3)',
    '    at run (/r/electron/platform/winbin.cjs:30:5)',
    '    at /r/electron/platform/gitQueries.cjs:12:7',
    '    at Object.branch (/r/electron/app/ipc/git.cjs:40:9)',
    '    at more (/r/electron/x.cjs:1:1)',
  ].join('\n');
  assert.equal(
    probe.callerOf(stack, '/r'),
    'electron/platform/winbin.cjs:30 < electron/platform/gitQueries.cjs:12 < electron/app/ipc/git.cjs:40',
  );
  assert.equal(probe.callerOf('Error\n    at node:internal/a:1:1', '/r'), '?');
  assert.equal(probe.callerOf('Error\n    at file:///r/tests/x.test.ts:5:6', '/r'), 'tests/x.test.ts:5');
  // the default root is the app's own
  assert.match(probe.callerOf(`Error\n    at f (${process.cwd()}/electron/main.cjs:3:4)`), /^electron\/main\.cjs:3$/);
});

test("a spawn is named by its program and first non-option word, by base name: git's subcommand, node's script", () => {
  assert.equal(probe.spawnName('/usr/bin/git', ['git', '-C', '/repo', 'status', '--porcelain']), 'git status');
  assert.equal(probe.spawnName('git', ['git', '--no-optional-locks', 'status']), 'git status');
  assert.equal(probe.spawnName('/bin/ps', ['ps', '-A', '-o', 'pid=,ppid=']), 'ps pid=,ppid=');
  assert.equal(probe.spawnName('/usr/local/bin/node', ['node', '/x/tests/fake-claude.mjs']), 'node fake-claude.mjs');
  assert.equal(probe.spawnName('sysctl', ['sysctl', '-n']), 'sysctl');
  assert.equal(probe.spawnName('x', ['x', 'a'.repeat(60)]), `x ${'a'.repeat(40)}`);
  assert.equal(probe.spawnName(undefined, undefined), '?');
  assert.equal(probe.spawnName('y', ['y', 7, '']), 'y');
});

test('appMetrics reads Electron’s app metrics, and none outside Electron', async (t) => {
  assert.deepEqual(probe.appMetrics(), []);
  const m = mock.module('electron', { exports: { app: { getAppMetrics: () => [{ type: 'Browser', pid: 9 }] } } });
  t.after(() => m.restore());
  assert.deepEqual(probe.appMetrics(), [{ type: 'Browser', pid: 9 }]);
});

test('a window’s mark is written on main’s timeline; one without its time stays as it came', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = probe.startProbe({ dir, id: 'r', now: () => 1, ...fakeTimers(), marks: () => [], onMark: () => () => undefined });
  probe.recordWindowSamples(3, [
    { t: 5, kind: 'mark', name: 'firstPaint', at: performance.timeOrigin + 120.5 },
    { t: 6, kind: 'mark', name: 'odd' },
  ]);
  await probe.stopProbe();
  const got = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((s) => s.kind === 'mark');
  assert.deepEqual(got, [
    { t: 1, kind: 'mark', name: 'firstPaint', ms: 120.5, window: 3 },
    { t: 6, kind: 'mark', name: 'odd', window: 3 },
  ]);
});

test('by default the idle sample reads main’s own CPU time', async () => {
  const { pushed, writer } = recorder();
  const timers = fakeTimers();
  const p = probe.createProbe({
    file: '/x.jsonl',
    now: () => 1,
    monitor,
    writer,
    ...timers,
    marks: () => [],
    onMark: () => () => undefined,
    metrics: () => [],
  });
  for (let i = 0; i < probe.IDLE_TICKS; i++) timers.cb!();
  const cpu = pushed.find((s) => s.kind === 'cpu');
  assert.ok(Number.isInteger(cpu.userMs) && Number.isInteger(cpu.systemMs));
  await p.stop();
});

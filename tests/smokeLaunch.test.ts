// The release's smoke launch of the packaged app: the app's side (electron/app/smokeLaunch.cjs, wired through main.cjs and
// startup.cjs) and the script that starts it and reads the result (scripts/smoke-launch.mjs), over fakes.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { flush, loadMain, unloadMain } from './support/electron-main-harness.ts';
import { runScript } from './support/scripts-shared-cli.ts';

const require = createRequire(import.meta.url);
const SMOKE = require.resolve('../electron/app/smokeLaunch.cjs');
const { installSmokeLaunch, currentSmokeLaunch } = require(SMOKE);
/** What electron/boot.cjs does before main: the reporter, in the module copy main's startup will load. */
const installForMain = (h: any, file: string) => require(SMOKE).installSmokeLaunch({ app: h.app, env: { MOPILOT_SMOKE_RESULT: file } });
const script = await import('../scripts/smoke-launch.mjs');

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

function fakeApp() {
  const app: any = new EventEmitter();
  app.exit = mock.fn();
  app.getVersion = () => '0.4.5-dogfood.2';
  const proc = new EventEmitter();
  const writes: [string, string][] = [];
  const io = { write: (f: string, t: string) => writes.push([f, t]) };
  return { app, proc, io, writes, exits: () => app.exit.mock.calls.map((c: any) => c.arguments[0]) };
}
const install = (f: ReturnType<typeof fakeApp>, env: Record<string, string> = { MOPILOT_SMOKE_RESULT: '/r.json' }) =>
  installSmokeLaunch({ app: f.app, env, write: f.io.write, proc: f.proc });
const written = (f: ReturnType<typeof fakeApp>) => f.writes.map(([file, text]) => [file, JSON.parse(text)]);

test('without MOPILOT_SMOKE_RESULT nothing is installed, replacing an earlier reporter', () => {
  const f = fakeApp();
  const earlier = install(f);
  assert.equal(currentSmokeLaunch(), earlier);
  f.proc.removeAllListeners();
  f.app.removeAllListeners();
  assert.equal(install(f, {}), null);
  assert.equal(currentSmokeLaunch(), null);
  assert.equal(f.proc.listenerCount('uncaughtException'), 0);
  assert.equal(f.app.listenerCount('web-contents-created'), 0);
});

test('a memory guard that cannot stop pages fails the launch: it has no fallback', () => {
  const f = fakeApp();
  const smoke = install(f);
  smoke.started();
  smoke.rendererReady();
  smoke.memoryGuard('its worker read no process table');
  assert.deepEqual(written(f), [['/r.json', { ok: false, error: 'browser memory guard: its worker read no process table' }]]);
  assert.deepEqual(f.exits(), [1]);
});

test('the launch passes only once startup finished, the renderer asked for app:ready and the memory guard reported, in any order', () => {
  for (const order of [
    ['started', 'rendererReady', 'memoryGuard'],
    ['memoryGuard', 'started', 'rendererReady'],
    ['rendererReady', 'memoryGuard', 'started'],
  ]) {
    const f = fakeApp();
    const smoke = install(f);
    smoke[order[0]](null);
    smoke[order[1]](null);
    assert.deepEqual(f.writes, [], `${order[0]} and ${order[1]} are not a start`);
    smoke[order[2]](null);
    smoke[order[2]](null);
    assert.deepEqual(written(f), [['/r.json', { ok: true, version: '0.4.5-dogfood.2' }]], 'with the version the app reports');
    assert.deepEqual(f.exits(), [0]);
  }
});

test('the first failure is reported and the app exits 1; later events change nothing', () => {
  const f = fakeApp();
  const smoke = install(f);
  f.proc.emit('uncaughtException', new Error("Cannot find module 'js-yaml'"));
  smoke.failed('later');
  smoke.started();
  smoke.rendererReady();
  const [[, result]] = written(f);
  assert.equal(result.ok, false);
  assert.match(result.error, /^uncaught exception: Error: Cannot find module 'js-yaml'/);
  assert.deepEqual(f.exits(), [1]);

  const g = fakeApp();
  install(g).failed('App startup timed out.');
  assert.deepEqual(written(g), [['/r.json', { ok: false, error: 'startup failed: App startup timed out.' }]]);
  const h = fakeApp();
  install(h);
  h.proc.emit('uncaughtException', 'thrown string');
  assert.equal(written(h)[0][1].error, 'uncaught exception: thrown string');
});

test('a renderer crash and a failed app page fail the launch; a guest page or subframe failing does not', () => {
  const f = fakeApp();
  install(f);
  f.app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 11 });
  assert.deepEqual(written(f), [['/r.json', { ok: false, error: 'renderer gone: crashed (11)' }]]);

  const g = fakeApp();
  install(g);
  const contents = new EventEmitter();
  g.app.emit('web-contents-created', {}, contents);
  contents.emit('did-fail-load', {}, -3, 'ABORTED', 'https://example.com/', true);
  contents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'file:///app/frame.html', false);
  assert.deepEqual(g.writes, []);
  contents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'file:///app/dist/index.html', true);
  assert.deepEqual(written(g), [['/r.json', { ok: false, error: 'page failed to load: file:///app/dist/index.html (-6 FILE_NOT_FOUND)' }]]);
});

test('the app still exits when the result cannot be written', () => {
  const f = fakeApp();
  f.io.write = () => {
    throw new Error('EACCES');
  };
  const smoke = install(f);
  assert.throws(() => smoke.failed('x'), /EACCES/);
  assert.deepEqual(f.exits(), [1]);
});

/** Run electron/boot.cjs with main and electron stubbed: the marks it left, and how often it timed requires. */
async function boot(t: any, requireTimes?: string) {
  const app = Object.assign(new EventEmitter(), { exit: mock.fn() });
  const startup = require('../electron/perf/startup.cjs');
  startup.resetStartupMarks();
  t.after(() => startup.resetStartupMarks());
  const timeRequires = mock.fn();
  const timing = t.mock.module(require.resolve('../electron/perf/requireTimes.cjs'), { exports: { timeRequires } });
  const electron = t.mock.module('electron', { exports: { app } });
  const main = t.mock.module(require.resolve('../electron/main.cjs'), { exports: {} });
  const saved = { smoke: process.env.MOPILOT_SMOKE_RESULT, times: process.env.MOPILOT_REQUIRE_TIMES };
  process.env.MOPILOT_SMOKE_RESULT = '/r.json';
  if (requireTimes === undefined) delete process.env.MOPILOT_REQUIRE_TIMES;
  else process.env.MOPILOT_REQUIRE_TIMES = requireTimes;
  const listeners = process.listeners('uncaughtException');
  try {
    delete require.cache[require.resolve('../electron/boot.cjs')];
    require('../electron/boot.cjs');
    assert.ok(require(SMOKE).currentSmokeLaunch(), 'the reporter is installed');
    assert.equal(app.listenerCount('web-contents-created'), 1);
    return { marks: startup.startupMarks().map((m: any) => m.name), timed: timeRequires.mock.callCount() };
  } finally {
    for (const l of process.listeners('uncaughtException')) if (!listeners.includes(l)) process.off('uncaughtException', l);
    for (const [k, v] of [
      ['MOPILOT_SMOKE_RESULT', saved.smoke],
      ['MOPILOT_REQUIRE_TIMES', saved.times],
    ] as const)
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    electron.restore();
    main.restore();
    timing.restore();
  }
}

test("Electron's entry point marks its start, installs the reporter, loads main, then marks it loaded", async (t) => {
  assert.deepEqual(await boot(t), { marks: ['boot', 'mainLoaded'], timed: 0 });
  assert.deepEqual(await boot(t, '0'), { marks: ['boot', 'mainLoaded'], timed: 0 });
});

test('MOPILOT_REQUIRE_TIMES=1 has boot time every file main loads, from before main', async (t) => {
  assert.deepEqual(await boot(t, '1'), { marks: ['boot', 'mainLoaded'], timed: 1 });
});

test('main: a smoke launch reports a finished startup once the window asks for app:ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-main-'));
  const file = path.join(dir, 'result.json');
  try {
    const h = await loadMain({ before: (h) => installForMain(h, file) });
    await h.ready();
    assert.equal(fs.existsSync(file), false, 'the renderer has not run yet');
    await h.invoke('app:ready');
    assert.equal(fs.existsSync(file), false, 'the memory guard has not reported yet');
    h.one('MemoryGuard').opts.onReady(null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true, version: '1.2.3' });
    assert.deepEqual(
      h.app.exit.mock.calls.map((c: any) => c.arguments),
      [[0]],
    );
  } finally {
    unloadMain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: a startup that fails is reported with its reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-main-'));
  const file = path.join(dir, 'result.json');
  try {
    const h = await loadMain({
      before: (h) => {
        installForMain(h, file);
        h.mod('platform/env.cjs').ready.mock.mockImplementation(async () => Promise.reject(new Error('no login shell')));
      },
    });
    await h.ready();
    await flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: false, error: 'startup failed: no login shell' });
    assert.equal(h.inst.Telemetry[0].flush.mock.calls.length, 1, 'a machine that always fails here still reports it');
    assert.deepEqual(
      h.app.exit.mock.calls.map((c: any) => c.arguments),
      [[1]],
    );
  } finally {
    unloadMain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A spawned app that writes `result` (or nothing) and exits with `code`, or never exits. */
function fakeRun({ result, code = 0, hang = false, error }: { result?: object; code?: number; hang?: boolean; error?: Error }) {
  const calls: any[] = [];
  const run = (exe: string, args: string[], opts: any) => {
    calls.push({ exe, args, opts });
    const child: any = new EventEmitter();
    child.kill = mock.fn();
    queueMicrotask(() => {
      if (error) return child.emit('error', error);
      if (result) fs.writeFileSync(opts.env.MOPILOT_SMOKE_RESULT, JSON.stringify(result));
      if (!hang) child.emit('exit', code);
    });
    return child;
  };
  return { run, calls };
}
const appDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-app-'));
const deps = (over: Record<string, unknown> = {}) => ({
  exists: () => true,
  tmp: appDir,
  env: { PATH: '/bin' },
  version: '1.2.3',
  ...over,
});
const started = { ok: true, version: '1.2.3' };

test('script: executable layouts and the native default cover macOS, Windows and Linux', () => {
  assert.equal(script.executableOf('/o/A.app', 'MoPilot', 'darwin'), path.join('/o/A.app', 'Contents', 'MacOS', 'MoPilot'));
  assert.equal(script.executableOf('/o/w', 'MoPilot', 'win32'), path.join('/o/w', 'MoPilot.exe'));
  assert.equal(script.executableOf('/o/linux', 'MoPilot', 'linux'), path.join('/o/linux', 'mopilot'));
  const native =
    process.platform === 'linux' ? 'mopilot' : process.platform === 'win32' ? 'MoPilot.exe' : path.join('Contents', 'MacOS', 'MoPilot');
  assert.equal(script.executableOf('/o/app'), path.join('/o/app', native));
});

test('script: a launch that reports a start passes, with scratch user data, background mode and the result file', async () => {
  const { run, calls } = fakeRun({ result: started });
  let removed = '';
  const result = await script.smokeLaunch('/o/A.app', {
    ...deps(),
    run,
    platform: 'darwin',
    productName: 'MoPilot',
    rm: (d: string) => (removed = d),
  });
  assert.deepEqual(result, started);
  const [{ exe, args, opts }] = calls;
  assert.equal(exe, '/o/A.app/Contents/MacOS/MoPilot');
  assert.deepEqual(args, []);
  assert.equal(opts.env.PATH, '/bin');
  assert.equal(opts.env.SAGE_E2E_BACKGROUND, '1');
  assert.equal(path.dirname(opts.env.MOPILOT_USER_DATA), removed);
  assert.equal(opts.env.MOPILOT_SMOKE_RESULT, path.join(removed, 'result.json'));
  fs.rmSync(removed, { recursive: true, force: true });
});

test('script: the launched release build is not an install, even with the workflow-wide MOPILOT_API', async () => {
  const { reportsToService } = require('../electron/platform/install.cjs');
  for (const MOPILOT_API of [undefined, 'https://mopilot.ai']) {
    const { run, calls } = fakeRun({ result: started });
    let removed = '';
    await script.smokeLaunch('/o/A.app', { ...deps({ env: { PATH: '/bin', MOPILOT_API } }), run, rm: (d: string) => (removed = d) });
    assert.equal(reportsToService(true, calls[0].opts.env, true), false, `MOPILOT_API ${MOPILOT_API}`);
    fs.rmSync(removed, { recursive: true, force: true });
  }
});

test('script: each way the app can fail to start is an error naming it, and the scratch folder is removed', async () => {
  const cases: [Parameters<typeof fakeRun>[0], RegExp][] = [
    [
      { result: { ok: false, error: "uncaught exception: Error: Cannot find module 'js-yaml'" }, code: 1 },
      /failed to start: uncaught exception: Error: Cannot find module 'js-yaml'/,
    ],
    [{ code: 1 }, /exited \(code 1\) without reporting/],
    [{ result: started, code: 3 }, /reported a start but exited with code 3/],
    [{ result: { ok: true, version: '1.2' } }, /reports version 1\.2, not the release's 1\.2\.3/],
    [{ result: { ok: true } }, /reports version undefined, not the release's 1\.2\.3/],
    [{ error: new Error('spawn EACCES') }, /did not start: spawn EACCES/],
  ];
  for (const [behavior, message] of cases) {
    const dirs: string[] = [];
    await assert.rejects(
      script.smokeLaunch('/o/w', {
        ...deps({ tmp: () => (dirs.push(appDir()), dirs.at(-1)) }),
        run: fakeRun(behavior).run,
        platform: 'win32',
      }),
      message,
    );
    assert.equal(fs.existsSync(dirs[0]), false);
  }
  await assert.rejects(
    script.smokeLaunch('/o/w', { ...deps(), exists: () => false, platform: 'win32', productName: 'P' }),
    /No app at .*P\.exe/,
  );
});

test('script: by default the scratch folder is a new one under the system temp folder, removed afterwards', async () => {
  const { run, calls } = fakeRun({ result: started });
  assert.deepEqual(await script.smokeLaunch('/o/A.app', { exists: () => true, run, version: '1.2.3' }), started);
  const scratch = path.dirname(calls[0].opts.env.MOPILOT_SMOKE_RESULT);
  assert.equal(path.dirname(scratch), os.tmpdir());
  assert.match(path.basename(scratch), /^mopilot-smoke-/);
  assert.equal(fs.existsSync(scratch), false);
});

test("script: the version a launch must report is the release workflow's, else package.json's", async () => {
  const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const launch = (env: Record<string, string>, version: string) =>
    script.smokeLaunch('/o/w', { ...deps(), version: undefined, env, run: fakeRun({ result: { ok: true, version } }).run });
  assert.deepEqual(await launch({ RELEASE_VERSION: '0.4.5-dogfood.2' }, '0.4.5-dogfood.2'), { ok: true, version: '0.4.5-dogfood.2' });
  // a Windows prerelease that reported its numeric resource version (0.4.5-dogfood.2 as 0.4.5) fails the release
  await assert.rejects(
    launch({ RELEASE_VERSION: '0.4.5-dogfood.2' }, '0.4.5'),
    /reports version 0\.4\.5, not the release's 0\.4\.5-dogfood\.2/,
  );
  assert.deepEqual(await launch({}, pkgVersion), { ok: true, version: pkgVersion });
});

test('script: an app that never finishes starting is killed at the timeout', async () => {
  const children: any[] = [];
  const { run } = fakeRun({ hang: true });
  const launch = script.smokeLaunch('/o/A.app', {
    ...deps(),
    run: (...a: any[]) => {
      const c = (run as any)(...a);
      children.push(c);
      return c;
    },
    timeoutMs: 5000,
  });
  await flush();
  mock.timers.tick(5000);
  await assert.rejects(launch, /did not finish starting within 5 s/);
  assert.deepEqual(
    children[0].kill.mock.calls.map((c: any) => c.arguments),
    [['SIGKILL']],
  );
});

test('script: the command line passes, fails, needs a path and is release-only', async () => {
  const log = mock.fn();
  const error = mock.fn();
  const gate = mock.fn();
  // the real gate: a release (MOPILOT_RELEASE=1) may launch
  const release = { ...deps(), env: { MOPILOT_RELEASE: '1' }, run: fakeRun({ result: started }).run };
  assert.equal(await script.main(['/o/A.app'], { log, error, ...release }), 0);
  assert.deepEqual(log.mock.calls[0].arguments, ['Smoke launch passed: /o/A.app']);
  assert.equal(await script.main(['/o/A.app'], { log, error, gate, ...deps(), run: fakeRun({ result: started }).run }), 0);
  assert.match(gate.mock.calls[0].arguments[0], /smoke launch/);
  assert.deepEqual(gate.mock.calls[0].arguments[2], { PATH: '/bin' });
  assert.equal(await script.main(['/o/A.app'], { log, error, gate, ...deps(), run: fakeRun({ code: 1 }).run }), 1);
  assert.match(error.mock.calls[0].arguments[0], /without reporting/);
  assert.equal(await script.main([], { log, error }), 2);
  const usage = runScript('scripts/smoke-launch.mjs', []);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: node scripts\/smoke-launch\.mjs/);
  const refused = mock.fn();
  const blocked = await script.main(['/o/A.app'], {
    error: refused,
    gate: () => {
      throw new Error('The smoke launch is release-only');
    },
  });
  assert.equal(blocked, 1);
  assert.match(refused.mock.calls[0].arguments[0], /release-only/);
});

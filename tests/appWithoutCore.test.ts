// A process whose Rust core did not load (electron/boot.cjs, electron/app/withoutCore.cjs): main is never loaded, the app reports why with its own reporter, a person sees the reinstall dialog, and it exits.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROBLEM = 'The Rust core at /App/core/mopilot_core.node did not load: it is not there';

/** Electron's app, as far as the stop and main's reporter use it, ready at once. */
function fakeApp(userData: string, packaged = true, locked = true) {
  const paths: Record<string, string> = { appData: path.dirname(userData), userData };
  /** the user data folder each lock was asked for in: Electron's lock is that folder's */
  const lockedIn: string[] = [];
  return Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    lockedIn,
    requestSingleInstanceLock: mock.fn(() => (lockedIn.push(paths.userData), locked)),
    exit: mock.fn(),
    setName: mock.fn(),
    getVersion: () => '9.9.9',
    getPath: (name: string) => paths[name],
    setPath: mock.fn((name: string, dir: string) => (paths[name] = dir)),
    whenReady: () => Promise.resolve(),
  });
}
const crashReporter = { start: mock.fn() };
const electron = {
  app: fakeApp(os.tmpdir()),
  dialog: { showErrorBox: mock.fn() },
  protocol: { registerSchemesAsPrivileged: mock.fn() },
  crashReporter,
};
// before anything that reads Electron loads: the stop, main's lifecycle and its reporter
mock.module('electron', { exports: electron });
/** main's reporter, through its shared interface: what the private service does with it is tested with that service */
const reporters: { o: any; crash: unknown[] }[] = [];
class RecordingTelemetry {
  consent = false;
  record: { o: any; crash: unknown[] };
  constructor(o: any) {
    this.record = { o, crash: [] };
    reporters.push(this.record);
  }
  startCrashReporter(choice: unknown) {
    this.record.crash.push(choice);
  }
  error() {}
  async flush() {}
}
mock.module(require.resolve('../electron/support/telemetry.cjs'), {
  exports: {
    ...require('../electron/support/usageConsent.cjs'),
    ...require('../electron/support/diagnosticIdentity.cjs'),
    Telemetry: RecordingTelemetry,
    harnessVersions: () => null,
    REPORT_MARKER: '',
  },
});
const { stopWithoutCore, REPORT_MS } = require('../electron/app/withoutCore.cjs');

/** A reporter that records what it was told, and whether it was asked to send. */
function fakeReporter(flush = () => Promise.resolve()) {
  return { error: mock.fn(), flush: mock.fn(flush) };
}

/** Run `fn` with console.error recorded. */
async function quietly(fn: () => Promise<unknown>) {
  const told = mock.method(console, 'error', () => undefined);
  try {
    await fn();
    return told.mock.calls.map((c) => c.arguments[0]);
  } finally {
    told.mock.restore();
  }
}

test('a packaged app without the core reports why, tells a person to reinstall and exits', async () => {
  const app = fakeApp(os.tmpdir());
  const dialog = { showErrorBox: mock.fn() };
  const telemetry = fakeReporter();
  const said = await quietly(() => stopWithoutCore(PROBLEM, { app, dialog, telemetry }));
  assert.deepEqual(
    telemetry.error.mock.calls.map((c: any) => c.arguments[0]),
    [{ message: PROBLEM, kind: 'startup' }],
  );
  assert.equal(telemetry.flush.mock.callCount(), 1);
  assert.deepEqual(said, [PROBLEM]);
  assert.deepEqual(dialog.showErrorBox.mock.calls[0].arguments, [
    'MoPilot cannot start',
    'Part of MoPilot is missing or damaged. Install it again from https://mopilot.ai/download.',
  ]);
  assert.deepEqual(app.exit.mock.calls[0].arguments, [1]);
});

test('a second launch while the first says why exits quietly: no second report or dialog', async () => {
  const app = fakeApp(os.tmpdir(), true, false);
  const dialog = { showErrorBox: mock.fn() };
  const telemetry = fakeReporter();
  const said = await quietly(() => stopWithoutCore(PROBLEM, { app, dialog, telemetry }));
  assert.deepEqual(app.exit.mock.calls[0].arguments, [0]);
  assert.equal(app.exit.mock.callCount(), 1);
  assert.equal(telemetry.error.mock.callCount(), 0);
  assert.equal(dialog.showErrorBox.mock.callCount(), 0);
  assert.deepEqual(said, []);
});

test('a quit while the report leaves (Cmd+Q, a logout) still exits 1, at once', async () => {
  const app = fakeApp(os.tmpdir());
  const dialog = { showErrorBox: mock.fn() };
  const told = mock.method(console, 'error', () => undefined);
  try {
    let sent: () => void = () => undefined;
    const stopped = stopWithoutCore(PROBLEM, { app, dialog, telemetry: fakeReporter(() => new Promise<void>((r) => (sent = r))) });
    await new Promise((resolve) => setImmediate(resolve));
    app.emit('will-quit');
    assert.deepEqual(app.exit.mock.calls[0].arguments, [1], 'exits 1 at the quit, without waiting for the report');
    sent();
    await stopped;
    assert.ok(app.exit.mock.calls.every((c: any) => c.arguments[0] === 1));
  } finally {
    told.mock.restore();
  }
});

test("a release's smoke launch without the core fails with the reason, and shows no dialog", async () => {
  const app = fakeApp(os.tmpdir());
  const dialog = { showErrorBox: mock.fn() };
  const written: string[] = [];
  const listeners = process.listeners('uncaughtException');
  const smoke = require('../electron/app/smokeLaunch.cjs');
  smoke.installSmokeLaunch({ app, env: { MOPILOT_SMOKE_RESULT: '/r.json' }, write: (_file: string, text: string) => written.push(text) });
  try {
    await quietly(() => stopWithoutCore(PROBLEM, { app, dialog, telemetry: fakeReporter() }));
  } finally {
    smoke.installSmokeLaunch({ app, env: {} });
    for (const l of process.listeners('uncaughtException')) if (!listeners.includes(l)) process.off('uncaughtException', l);
  }
  assert.deepEqual(JSON.parse(written[0]), { ok: false, error: `startup failed: ${PROBLEM}` });
  assert.equal(dialog.showErrorBox.mock.callCount(), 0);
  assert.deepEqual(app.exit.mock.calls.at(-1)?.arguments, [1]);
});

test('a checkout without the core stops with the reason and no dialog nobody could dismiss', async () => {
  const app = fakeApp(os.tmpdir(), false);
  const dialog = { showErrorBox: mock.fn() };
  const said = await quietly(() => stopWithoutCore(PROBLEM, { app, dialog, telemetry: fakeReporter() }));
  assert.deepEqual(said, [PROBLEM]);
  assert.equal(dialog.showErrorBox.mock.callCount(), 0);
  assert.deepEqual(app.exit.mock.calls[0].arguments, [1]);
});

test('a report that cannot leave holds the exit no longer than its limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp(os.tmpdir());
  const dialog = { showErrorBox: mock.fn() };
  const told = mock.method(console, 'error', () => undefined);
  t.after(() => told.mock.restore());
  const stopped = stopWithoutCore(PROBLEM, { app, dialog, telemetry: fakeReporter(() => new Promise(() => undefined)) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.exit.mock.callCount(), 0, 'the report is still leaving');
  t.mock.timers.tick(REPORT_MS);
  await stopped;
  assert.deepEqual(app.exit.mock.calls[0].arguments, [1]);
});

test("by default the report goes through main's own reporter, from the app's user data, with the user's usage choice", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'no-core-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify({ prefs: { shareUsageData: false } }));
  const saved = process.env.MOPILOT_USER_DATA;
  process.env.MOPILOT_USER_DATA = userData;
  const listeners = { u: process.listeners('uncaughtException'), r: process.listeners('unhandledRejection') };
  t.after(() => {
    saved === undefined ? delete process.env.MOPILOT_USER_DATA : (process.env.MOPILOT_USER_DATA = saved);
    for (const [event, before] of [
      ['uncaughtException', listeners.u],
      ['unhandledRejection', listeners.r],
    ] as const)
      for (const l of process.listeners(event as any)) if (!before.includes(l)) process.off(event as any, l);
  });
  const app = fakeApp(path.join(os.tmpdir(), 'elsewhere'), false);
  await quietly(() => stopWithoutCore(PROBLEM, { app, dialog: electron.dialog }));
  assert.deepEqual(app.setPath.mock.calls[0].arguments, ['userData', userData]);
  assert.deepEqual(app.lockedIn, [userData], "the lock is the app's user data folder's, taken once it is set, as main takes it");
  const reporter = reporters.at(-1);
  assert.equal(reporter?.o.userData, userData);
  assert.deepEqual(reporter?.crash, [false], 'the user turned usage data off');
  assert.deepEqual(app.exit.mock.calls[0].arguments, [1]);
});

test("Electron's entry runs the stop instead of main when the core did not load, and main when it did", async (t) => {
  const startup = require('../electron/perf/startup.cjs');
  const boot = async (problem: string | null) => {
    startup.resetStartupMarks();
    const stops: string[] = [];
    const mocks = [
      t.mock.module(require.resolve('../electron/platform/core.cjs'), { exports: { coreProblem: () => problem } }),
      t.mock.module(require.resolve('../electron/app/withoutCore.cjs'), {
        exports: { stopWithoutCore: (why: string) => (stops.push(why), Promise.resolve()) },
      }),
      t.mock.module(require.resolve('../electron/main.cjs'), { exports: {} }),
    ];
    try {
      delete require.cache[require.resolve('../electron/boot.cjs')];
      require('../electron/boot.cjs');
      // `mainLoaded` is marked only once main has loaded
      return { stops, marks: startup.startupMarks().map((m: any) => m.name) };
    } finally {
      for (const m of mocks) m.restore();
      startup.resetStartupMarks();
    }
  };
  assert.deepEqual(await boot(PROBLEM), { stops: [PROBLEM], marks: ['boot'] });
  assert.deepEqual(await boot(null), { stops: [], marks: ['boot', 'mainLoaded'] });
});

// Restart to update records the chat the main window shows (and, for a stealth restart, how the window was) just before it quits, and forgets it when the restart failed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let opts: any;
let stealthOpts: any;
let gateOpts: any;
const flags: Record<string, boolean> = { 'app.update.stealth': true };
let summary: any = { turns: [], background: 0, goals: [] };
const gateCalls: any[] = [];
const reopened = { n: 0 };
const busy = { unsent: false, pty: false };
mock.module('../electron/app/unsent.cjs', { namedExports: { anyUnsent: () => busy.unsent } });
mock.module('../electron/platform/pty.cjs', { namedExports: { busy: () => busy.pty } });
const stealth = { installing: false, reset: mock.fn(), stop: mock.fn() };
mock.module('../electron/platform/flags.cjs', { namedExports: { refreshFlags: async () => false, isEnabled: (k: string) => !!flags[k] } });
mock.module('../electron/platform/install.cjs', { namedExports: { installId: () => 'install' } });
mock.module('../electron/platform/exitGate.cjs', {
  namedExports: {
    createExitGate: (o: any) => (
      (gateOpts = o),
      {
        request: async (...a: any[]) => (gateCalls.push(a), true),
        collect: async () => summary,
        reopen: () => reopened.n++,
      }
    ),
    isEmpty: () => true,
    quietBlocked: (sum: any, confirmClose: string) => confirmClose === 'always' || sum.turns.length > 0,
  },
});
mock.module('../electron/app/stealthUpdate.cjs', {
  namedExports: { createStealthUpdate: (o: any) => ((stealthOpts = o), stealth) },
});
mock.module('../electron/updates/updater.cjs', {
  namedExports: {
    Updater: class {
      channel = 'stable';
      state = { status: 'idle' };
      manual = false;
      install = mock.fn(async () => true);
      constructor(o: any) {
        opts = o;
      }
      configure() {
        return {};
      }
    },
  },
});
const { createUpdates } = await import('../electron/app/updates.cjs');

function load(
  prefs: any = {},
  version = '2.0.0',
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-view-')),
  telemetry?: { track: (...a: any[]) => void },
) {
  const on = new Map<string, () => void>();
  const main: any = {
    isDestroyed: () => false,
    webContents: { id: 7 },
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => false,
    isFullScreen: () => false,
  };
  const shown: { w: any } = { w: main };
  const focus = { focused: false, fullScreen: false };
  const win = {
    mainWindow: () => shown.w,
    viewedBy: new Map([[7, { visible: ['chat:2', 'chat:1'], primary: 'chat:1', focused: 'chat:2' }]]),
    anyFocused: () => focus.focused,
    anyFullScreen: () => focus.fullScreen,
  };
  const live: any = { mopilot: { status: () => ({ user: null }) }, devPreviews: { servers: new Map() }, telemetry };
  const sent: any[] = [];
  const updates = createUpdates({
    app: { getPath: () => userData, getVersion: () => version, on: (e: string, fn: () => void) => on.set(e, fn) },
    ipcMain: {},
    dialog: {},
    claude: {},
    readState: () => ({ prefs }),
    win,
    broadcastAll: (...a: any[]) => sent.push(a),
    live,
    windowReadiness: { has: () => true },
  } as any);
  updates.openUpdates();
  return { updates, file: path.join(userData, 'restart-view.json'), shown, main, focus, live, on, sent };
}

test('the exit gate asks the live keeps-running handle, and has none until the app wires one', () => {
  const { live } = load();
  assert.equal(gateOpts.keepsRunning(), null);
  live.keepsRunning = { owns: () => true };
  assert.equal(gateOpts.keepsRunning(), live.keepsRunning);
});

test('update outcomes reach usage data on the channel in use: a new version, then a failure', () => {
  const tracked: any[][] = [];
  const telemetry = { track: (...a: any[]) => tracked.push(a) };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-view-'));
  load({}, '1.0.0', userData, telemetry);
  assert.deepEqual(tracked, [], 'a first install reports nothing');
  load({}, '2.0.0', userData, telemetry);
  assert.deepEqual(tracked, [['update_installed', { from: '1.0.0', version: '2.0.0', channel: 'stable' }]]);
  tracked.length = 0;
  opts.broadcast({ status: 'downloading', error: null, progress: { version: '3.0.0' } });
  opts.broadcast({ status: 'error', error: 'no network' });
  assert.deepEqual(tracked, [['update_failed', { stage: 'download', version: '3.0.0', channel: 'stable' }]]);
  load({}, '2.0.0', userData);
  opts.broadcast({ status: 'downloading', error: null, progress: { version: '3.0.0' } });
  opts.broadcast({ status: 'error', error: 'no network' });
  assert.equal(tracked.length, 1, 'no telemetry yet is not a crash');
});

test("the main window's chat is saved as the updater starts installing, cleared if it goes back, and opened once", () => {
  const { updates, file, shown, sent } = load();
  opts.broadcast({ status: 'ready' });
  assert.equal(fs.existsSync(file), false, 'nothing saved, nothing to clear');
  opts.broadcast({ status: 'installing' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { chatId: 'chat:1', ts: JSON.parse(fs.readFileSync(file, 'utf8')).ts });
  assert.deepEqual(sent.at(-1), ['updates:state', { status: 'installing' }], 'the windows still hear the state');
  // the restart failed: the downloaded update is offered again, the next launch opens as usual, and the next quit asks
  const before = reopened.n;
  opts.broadcast({ status: 'ready', error: 'x' });
  assert.equal(fs.existsSync(file), false);
  assert.equal(reopened.n, before + 1);
  opts.broadcast({ status: 'installing' });
  assert.deepEqual(updates.restartLaunch(), { hash: 'thread=chat%3A1', window: undefined });
  assert.deepEqual(updates.restartLaunch(), {}, 'once');
  // a main window that is gone, or none, shows no chat
  for (const w of [{ isDestroyed: () => true, webContents: { id: 7 } }, null]) {
    shown.w = w;
    opts.broadcast({ status: 'installing' });
    assert.equal(fs.existsSync(file), false);
  }
});

test('a stealth restart records how the main window was, and goes through the exit gate quietly', async () => {
  const { updates, file, main, shown } = load();
  stealth.installing = true;
  try {
    for (const [visible, minimized, expected] of [
      [true, false, { visible: true, minimized: false }],
      [true, true, { visible: false, minimized: true }],
      [false, false, { visible: false, minimized: false }],
    ] as const) {
      main.isVisible = () => visible;
      main.isMinimized = () => minimized;
      opts.broadcast({ status: 'installing' });
      assert.deepEqual(updates.restartLaunch().window, expected);
    }
    shown.w = null;
    opts.broadcast({ status: 'installing' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).window, { visible: false, minimized: false }, 'no window: it stays hidden');
    await opts.gate('update');
    assert.deepEqual(gateCalls.at(-1), ['update', { quiet: true }]);
  } finally {
    stealth.installing = false;
  }
  await opts.gate('quit');
  assert.deepEqual(gateCalls.at(-1), ['quit', { quiet: false }], 'a restart the user asked for may ask');
});

test('the stealth restart reads the switch, the update, every window and the quiet exit gate', async () => {
  const { updates, focus, live, on } = load({ confirmClose: 'shortcut' });
  assert.equal(stealthOpts.enabled(), true);
  flags['app.update.stealth'] = false;
  assert.equal(stealthOpts.enabled(), false, 'the remote switch turns it off');
  flags['app.update.stealth'] = true;
  updates.configureUpdates({ auto: false, channel: 'stable' });
  assert.equal(stealthOpts.enabled(), false, 'so does turning automatic updates off');
  updates.configureUpdates({ auto: true, channel: 'stable' });
  const u: any = updates.updater;
  assert.equal(stealthOpts.ready(), false);
  u.state = { status: 'ready' };
  assert.equal(stealthOpts.ready(), true);
  u.manual = true;
  assert.equal(stealthOpts.ready(), false, 'Windows installs by hand: nothing to restart into');
  assert.equal(stealthOpts.focused(), false);
  focus.focused = true;
  assert.equal(stealthOpts.focused(), true, 'any window, the in-app browser popups included');
  assert.equal(stealthOpts.fullScreen(), false);
  focus.fullScreen = true;
  assert.equal(stealthOpts.fullScreen(), true);
  assert.equal(await stealthOpts.quiet(), true);
  summary = { turns: [1], background: 0, goals: [] };
  assert.equal(await stealthOpts.quiet(), false, 'a running turn');
  summary = { turns: [], background: 0, goals: [] };
  for (const [what, set, unset] of [
    ['an unsent draft', () => (busy.unsent = true), () => (busy.unsent = false)],
    ['a command in a terminal', () => (busy.pty = true), () => (busy.pty = false)],
    ['a dev server a chat started', () => live.devPreviews.servers.set('s', {}), () => live.devPreviews.servers.clear()],
  ] as const) {
    set();
    assert.equal(await stealthOpts.quiet(), false, what);
    unset();
  }
  live.devPreviews = undefined;
  assert.equal(await stealthOpts.quiet(), true, 'no dev previews set up yet');
  const before = reopened.n;
  await stealthOpts.install();
  assert.equal(u.install.mock.callCount(), 1);
  assert.equal(reopened.n, before, 'it restarted: the gate stays as it is');
  u.install = mock.fn(async () => false);
  await stealthOpts.install();
  assert.equal(reopened.n, before + 1, 'an install that never started reopens the gate');
  on.get('browser-window-focus')!();
  assert.equal(stealth.reset.mock.callCount(), 1, 'the user is back: the wait starts again');
  on.get('will-quit')!();
  assert.equal(stealth.stop.mock.callCount(), 1);
});

test('a user who wants to be asked on every quit is never restarted silently', async () => {
  load({ confirmClose: 'always' });
  assert.equal(await stealthOpts.quiet(), false);
  load({ confirmClose: 'never' });
  summary = { turns: [1], background: 0, goals: [] };
  assert.equal(await stealthOpts.quiet(), false, '"never ask" still never stops running work');
  summary = { turns: [], background: 0, goals: [] };
});

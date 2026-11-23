// Mobile Remote with no window open: the menu-bar item, the IPC every window reads from, the quiet login start and quitting (electron/app/alwaysOn*.cjs, electron/ipc/alwaysOn.cjs, electron/app/menu.cjs, electron/app/lifecycle.cjs).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/alwaysOnRig.ts';
import { loadMain, unloadMain, withPlatform } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const { createMenus } = require('../electron/app/menu.cjs');
const { register } = require('../electron/app/ipc/alwaysOn.cjs');
const bridge = require('../electron/bridge/alwaysOn.cjs');
const { openAlwaysOn, openStartupWindow, startRemote } = require('../electron/app/alwaysOnWiring.cjs');

mock.timers.enable({ apis: ['setInterval'] });
after(() => {
  unloadMain();
  mock.timers.reset();
});

function ipc(live: any) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  register({ handle: (ch: string, fn: any) => handlers.set(ch, fn) }, { live });
  return (ch: string, ...a: unknown[]): any => handlers.get(ch)!({}, ...a);
}

test('windows read and move the switches through main, and a failed save says so', () => {
  const r = rig();
  r.remote.start();
  const call = ipc({ alwaysOn: r.alwaysOn });
  assert.equal(call('alwaysOn:get').remoteOn, true);
  assert.equal(call('alwaysOn:set', { keepRunning: true }).active, true);
  const broken = {
    get: () => null,
    set: () => {
      throw new Error('disk full');
    },
  };
  assert.throws(() => ipc({ alwaysOn: broken })('alwaysOn:set', { keepRunning: true }), /Couldn't save the setting: disk full/);
  const odd = {
    get: () => null,
    set: () => {
      throw 'not an Error';
    },
  };
  assert.throws(() => ipc({ alwaysOn: odd })('alwaysOn:set', {}), /Couldn't save the setting: not an Error/);
  assert.equal(ipc({})('alwaysOn:get'), null, 'before startup made it');
  assert.throws(() => ipc({})('alwaysOn:set', {}), /not ready yet/);
  assert.deepEqual(Object.keys(bridge), ['get', 'set', 'onChanged']);
});

test('the wiring tells every window when the state changes and redraws the tray', () => {
  const r = rig();
  const sent: unknown[][] = [];
  let redraws = 0;
  const live = r.live;
  const alwaysOn = openAlwaysOn({
    app: Object.assign(r.app, { getPath: () => r.userData }),
    menus: { refreshTray: () => void redraws++ },
    live,
    ignored: () => undefined,
    broadcastAll: (...a: unknown[]) => void sent.push(a),
    electron: { BrowserWindow: { getAllWindows: () => [] }, powerSaveBlocker: undefined } as any,
  });
  r.remote.start();
  alwaysOn.set({ keepRunning: true });
  assert.equal(sent.at(-1)![0], 'alwaysOn:changed');
  assert.equal((sent.at(-1)![1] as any).active, true);
  assert.ok(redraws > 0);
  r.app.emit('browser-window-created', {}, Object.assign(new (require('node:events').EventEmitter)(), {}));
  // the quiet-start check reads the remote.enabled flag through the wiring
  alwaysOn.set({ loginItem: true });
  r.app.login.wasOpenedAtLogin = true;
  assert.equal(typeof alwaysOn.startsQuietly(), 'boolean');
  alwaysOn.close();
});

test('a login-item start opens no window and the window comes only if the menu-bar item did not', async () => {
  const opened: string[] = [];
  assert.equal(
    openStartupWindow({ startsQuietly: () => false }, () => opened.push('window')),
    false,
  );
  assert.equal(
    openStartupWindow({ startsQuietly: () => true }, () => opened.push('window')),
    true,
  );
  assert.deepEqual(opened, ['window']);
  const shown: string[] = [];
  const make = (active: boolean) => ({
    remote: { sync: async () => void shown.push('sync') },
    alwaysOn: { sync: () => void shown.push('follow'), active },
  });
  await startRemote({ live: make(true), quiet: true, showMainWindow: () => shown.push('show') });
  await startRemote({ live: make(false), quiet: false, showMainWindow: () => shown.push('show') });
  assert.deepEqual(shown, ['sync', 'follow', 'sync', 'follow']);
  await startRemote({ live: make(false), quiet: true, showMainWindow: () => shown.push('show') });
  assert.equal(shown.at(-1), 'show', 'a quiet start with nothing in the menu bar would leave the app invisible');
});

const commands: unknown[][] = [];
let commandFails = false;
function trayRig(live: any, isWin = false) {
  const trays: any[] = [];
  class FakeTray {
    menu: any;
    tooltip = '';
    destroyed = false;
    constructor() {
      trays.push(this);
    }
    on() {}
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setTitle() {}
    setContextMenu(m: unknown) {
      this.menu = m;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const shown: string[] = [];
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: () => undefined },
    Tray: FakeTray,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
    globalShortcut: {},
    shell: {},
    BrowserWindow: { getFocusedWindow: () => null },
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin,
    win: {
      windows: new Set(),
      mainWindow: () => null,
      createWindow: () => undefined,
      showMainWindow: async () => void shown.push('open'),
      commandMainWindow: async (...args: unknown[]) => {
        commands.push(args);
        if (commandFails) throw new Error('no window');
      },
      toggleMini: () => undefined,
    },
    live,
  });
  return { menus, trays, shown };
}

test('the menu-bar item shows the paired-phone state and Open MoPilot while the app is kept up, and goes with it', () => {
  const live: any = {};
  const t = trayRig(live);
  const r = rig();
  live.alwaysOn = r.alwaysOn;
  r.remote.start();
  r.remote.pair('p');
  r.alwaysOn.set({ keepRunning: true });
  t.menus.refreshTray();
  assert.equal(t.trays.length, 1);
  const labels = t.trays[0].menu.map((i: any) => i.label ?? i.type ?? i.role);
  assert.deepEqual(labels, [
    'Open MoPilot',
    'New Chat',
    'Open Quick Chat',
    'separator',
    'Phones · 1 connected',
    'separator',
    'Quit MoPilot',
  ]);
  assert.ok(labels.includes('Open MoPilot'));
  assert.equal(labels.includes('Show MoPilot'), false);
  assert.ok(
    t.trays[0].menu.some((i: any) => i.role === 'quit'),
    'Quit really quits',
  );
  t.trays[0].menu.find((i: any) => i.label === 'Open MoPilot').click();
  assert.deepEqual(t.shown, ['open']);
  r.alwaysOn.set({ keepRunning: false });
  t.menus.refreshTray();
  assert.equal(t.trays[0].destroyed, true);
  assert.equal(t.menus.tray, null);
});

test('with no phone paired the tray offers phone settings after the app actions', async () => {
  const live: any = {};
  const t = trayRig(live);
  const r = rig();
  live.alwaysOn = r.alwaysOn;
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true });
  t.menus.refreshTray();
  const first = t.trays[0].menu[4];
  assert.equal(first.label, 'Connect a phone…');
  first.click();
  assert.deepEqual(commands.at(-1), ['settings', 'connections']);
  commandFails = true;
  first.click();
  await new Promise((resolve) => setImmediate(resolve));
  commandFails = false;
  r.alwaysOn.set({ keepRunning: false });
  t.menus.refreshTray();
});

test('paired phone details and Manage phones both open Settings without a window', async () => {
  const r = rig();
  const t = trayRig({ alwaysOn: r.alwaysOn });
  r.remote.start();
  r.remote.pair('Work phone', 'gone');
  r.alwaysOn.set({ keepRunning: true });
  t.menus.setTray(true);
  const phones = t.trays[0].menu.find((item: any) => item.submenu);
  assert.equal(phones.label, 'Phones · 0 connected');
  assert.equal(phones.submenu[1].label, 'Work phone — Offline');
  phones.submenu[1].click();
  assert.deepEqual(commands.at(-1), ['settings', 'connections']);
  phones.submenu.at(-1).click();
  assert.deepEqual(commands.at(-1), ['settings', 'connections']);
  commandFails = true;
  phones.submenu.at(-1).click();
  await new Promise((resolve) => setImmediate(resolve));
  commandFails = false;
  r.alwaysOn.close();
});

test('without always-on the tray keeps its own items', () => {
  const t = trayRig({});
  t.menus.setTray(true);
  const labels = t.trays[0].menu.map((i: any) => i.label);
  assert.ok(labels.includes('Show MoPilot'));
  assert.equal(
    labels.some((l: string) => l?.includes('Mobile Remote')),
    false,
  );
});

test('closing the last window during a turn, a pending card or a pairing leaves the runtime and its work alone', () => {
  const r = rig();
  const closed: string[] = [];
  const channel = r.live.remote;
  r.remote.start();
  // main owns these, not the window: a running turn, an approval card waiting in its chat, a pairing waiting for the QR scan
  const work = { turn: 'running', card: 'pending', pairing: 'waiting' };
  Object.assign(channel, { close: () => closed.push('runtime'), cancelPairing: () => closed.push('pairing') });
  r.alwaysOn.watchWindows();
  const w = r.makeWindow();
  r.alwaysOn.set({ keepRunning: true });
  w.visible = false;
  w.gone = true;
  w.emit('closed');
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('dock')),
    ['dock:hide'],
  );
  assert.deepEqual(closed, [], 'the runtime and the pairing were not closed with the window');
  assert.equal(r.live.remote.running, true);
  assert.deepEqual(work, { turn: 'running', card: 'pending', pairing: 'waiting' });
  assert.equal(r.alwaysOn.active, true);
  // a window opened later reads the running state from main
  const later = ipc({ alwaysOn: r.alwaysOn })('alwaysOn:get');
  assert.equal(later.remoteOn, true);
  r.makeWindow();
  assert.equal(r.log.at(-1), 'dock:show');
});

test('a quit before the controller exists goes on to the CLI cleanup as it did', async () => {
  const h = await loadMain();
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  assert.equal(h.claude.closeAll.mock.callCount(), 1);
});

test('the last window closing quits on Windows only without the menu-bar item', async () => {
  const h = await loadMain();
  await h.ready();
  await withPlatform('win32', () => h.app.emit('window-all-closed'));
  assert.equal(h.app.quit.mock.callCount(), 1, 'always-on is not active: the old rule');
});

test('a quit that passed the exit gate releases the controller before the rest of the cleanup', async () => {
  const h = await loadMain();
  await h.ready();
  h.inst.exitGate[0].passed = true;
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  assert.equal(h.claude.closeAll.mock.callCount(), 1, 'the cleanup went on after the controller was released');
});

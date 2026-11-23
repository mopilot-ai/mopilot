// Computer History's IPC and menu bar (#1363, electron/app/ipc/computerHistory.cjs, computerHistory/tray.cjs and the tray in electron/app/menu.cjs): it starts once the app is ready with no window, each call reaches the recorder and answers with the state, and the tray icon is up with Pause / Resume / Manage while Computer History is on, whatever the tray setting.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/computerHistory.cjs');
const { appComputerHistory } = require('../electron/computerHistory/service.cjs');
const tray = require('../electron/computerHistory/tray.cjs');
const indicator = require('../electron/computerHistory/indicator.cjs');
const { createMenus } = require('../electron/app/menu.cjs');
const bridge = require('../electron/bridge/computerHistory.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function fakeIpc() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    handlers,
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    call: (ch: string, ...a: unknown[]): any => handlers.get(ch)!({}, ...a),
  };
}

test('before the app is ready every call says Computer History has not started; a failed start is recorded, not thrown', async () => {
  const ipc = fakeIpc();
  register(
    ipc,
    { app: { whenReady: () => Promise.reject(new Error('no app')) }, broadcastAll: () => undefined, live: {} },
    { history: () => null, electron: {} },
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await ipc.call('computerHistory:state'), { ok: false, error: 'Computer History has not started yet' });
});

test('what it starts with: the user data folder, the helper and deny list of computer use while it is set up', async () => {
  let opts: any = null;
  const live: { computerUse: any } = { computerUse: null };
  const app = Object.assign(new EventEmitter(), { whenReady: async () => undefined, getPath: (n: string) => `/tmp/${n}` });
  register(fakeIpc(), { app, broadcastAll: () => undefined, live }, { history: () => null, electron: {}, start: (o: any) => (opts = o) });
  await new Promise((r) => setImmediate(r));
  assert.equal(opts.userData, '/tmp/userData');
  assert.equal(opts.safeStorage, null);
  assert.equal(opts.powerMonitor, null);
  assert.equal(opts.helper(), null);
  assert.deepEqual(opts.userDeny(), []);
  live.computerUse = { helper: 'h', grants: { deny: () => ['com.example.app'] } };
  assert.equal(opts.helper(), 'h');
  assert.deepEqual(opts.userDeny(), ['com.example.app']);
  live.computerUse = {};
  assert.equal(opts.helper(), null);
  assert.deepEqual(opts.userDeny(), []);
});

test('the bridge declares exactly the channels main handles', () => {
  const ipc = fakeIpc();
  register(
    ipc,
    { app: { whenReady: () => new Promise(() => undefined) }, broadcastAll: () => undefined, live: {} },
    { history: () => null, electron: {} },
  );
  const declared = Object.values(bridge).map((m: any) => m.channel);
  assert.deepEqual(declared.filter((c: string) => c !== 'computerHistory:changed').sort(), [...ipc.handlers.keys()].sort());
});

test('once ready it runs with no window, and every call reaches the recorder', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ipc-'));
  dirs.push(userData);
  const ipc = fakeIpc();
  const sent: unknown[] = [];
  let apps: unknown = {
    apps: [
      { bundleId: 'com.apple.Notes', name: 'Notes' },
      { bundleId: 'com.1password.1password', name: '1P' },
    ],
  };
  const helper = {
    call: async (m: string) => {
      if (m !== 'apps.list') return { bundleId: 'com.apple.Notes', name: 'Notes', title: 'Plan', secure: false };
      if (apps instanceof Error) throw apps;
      return apps;
    },
    idleSeconds: async () => 0,
  };
  const live: { computerUse: any } = { computerUse: { helper, grants: { deny: () => [] } } };
  const app = Object.assign(new EventEmitter(), { whenReady: async () => undefined, getPath: () => userData });
  register(
    ipc,
    { app, broadcastAll: (ch: string, s: unknown) => sent.push([ch, s]), live },
    { electron: { safeStorage: fakeSafe(), powerMonitor: null } },
  );
  await new Promise((r) => setImmediate(r));
  const h = appComputerHistory();
  assert.ok(h);
  assert.equal(h.store.dir, path.join(userData, 'computer-history'));
  const st = await ipc.call('computerHistory:state');
  assert.equal(st.state.status, 'off');
  assert.ok(st.exclusions.apps.length > 5);
  assert.equal((await ipc.call('computerHistory:setEnabled', true)).state.status, 'recording');
  assert.ok(sent.some(([ch]: any) => ch === 'computerHistory:changed'));
  assert.equal((await ipc.call('computerHistory:setEnabled', 'yes')).state.status, 'off', 'only true turns it on');
  await ipc.call('computerHistory:setEnabled', true);
  assert.equal((await ipc.call('computerHistory:allowApp', { bundleId: 'com.apple.Notes', name: 'Notes' })).ok, true);
  assert.equal((await ipc.call('computerHistory:allowApp', { bundleId: 'com.1password.1password' })).ok, false);
  assert.equal((await ipc.call('computerHistory:allowSite', 'example.com')).site, 'example.com');
  await h.recorder.tick();
  assert.equal((await ipc.call('computerHistory:pause')).state.status, 'paused');
  assert.equal((await ipc.call('computerHistory:resume')).state.status, 'recording');
  const today = (await ipc.call('computerHistory:days')).days;
  assert.equal(today.length, 1);
  assert.equal((await ipc.call('computerHistory:memories', { days: today })).memories.length, 1);
  assert.equal((await ipc.call('computerHistory:memories', 'junk')).memories.length, 1, 'junk asks for today');
  assert.equal((await ipc.call('computerHistory:setRetention', '14')).state.settings.retentionDays, 14);
  assert.equal((await ipc.call('computerHistory:explainerSeen')).state.settings.explainerSeen, true);
  await ipc.call('computerHistory:removeSite', 'example.com');
  await ipc.call('computerHistory:removeApp', 'com.apple.Notes');
  assert.deepEqual(h.recorder.settings.apps, []);
  await ipc.call('computerHistory:deleteDay', today[0]);
  assert.equal((await ipc.call('computerHistory:deleteDay', '../x')).ok, false);
  await ipc.call('computerHistory:deleteAll');
  assert.deepEqual((await ipc.call('computerHistory:days')).days, []);
  const c = await ipc.call('computerHistory:candidates');
  assert.deepEqual(
    c.apps.map((a: { excluded: string | null }) => a.excluded),
    [null, 'password manager'],
  );
  apps = new Error('helper gone');
  assert.deepEqual(await ipc.call('computerHistory:candidates'), { ok: false, error: 'Could not list the running apps' });
  live.computerUse = null;
  assert.equal((await ipc.call('computerHistory:candidates')).ok, false);
  await ipc.call('computerHistory:setEnabled', false);
});

test('the tray items say what Computer History does and offer Pause or Resume and Manage', () => {
  const calls: string[] = [];
  const actions = { pause: () => calls.push('pause'), resume: () => calls.push('resume'), manage: () => calls.push('manage') };
  assert.deepEqual(tray.trayItems('off', actions), []);
  assert.equal(tray.shows('off'), false);
  for (const s of ['recording', 'paused', 'suspended', 'needs-permission', 'unavailable', 'store-unavailable'])
    assert.equal(tray.shows(s), true, s);
  const rec = tray.trayItems('recording', actions);
  assert.equal(rec[0].label, 'Computer History is recording');
  assert.equal(rec[0].enabled, false);
  rec[1].click();
  rec[2].click();
  tray.trayItems('paused', actions)[1].click();
  assert.deepEqual(calls, ['pause', 'manage', 'resume']);
});

test('the menu bar icon is up while Computer History is on even with the tray setting off, and its items act', async () => {
  class FakeTray {
    static made: FakeTray[] = [];
    tooltip = '';
    menu: any[] = [];
    destroyed = false;
    constructor() {
      FakeTray.made.push(this);
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: any[]) {
      this.menu = m;
    }
    setTitle() {}
    on() {}
    destroy() {
      this.destroyed = true;
    }
  }
  const commands: unknown[][] = [];
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: () => undefined },
    Tray: FakeTray,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
    globalShortcut: {},
    shell: {},
    BrowserWindow: { getFocusedWindow: () => null },
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin: false,
    win: {
      windows: new Set(),
      mainWindow: () => null,
      createWindow: () => undefined,
      showMainWindow: async () => undefined,
      commandMainWindow: async (...a: unknown[]) => void commands.push(a),
      toggleMini: () => undefined,
    },
    live: {},
  });
  indicator.set({ status: 'off' });
  assert.equal(menus.tray, null);
  indicator.set({ status: 'recording' });
  const t = menus.tray as unknown as FakeTray;
  assert.ok(t);
  assert.equal(t.tooltip, 'Computer History is recording');
  assert.equal(t.menu[0].label, 'Computer History is recording');
  const h = appComputerHistory();
  await h.act((r: any) => r.setEnabled(true));
  t.menu[1].click();
  assert.equal(h.recorder.status, 'paused');
  indicator.set({ status: 'paused' });
  (menus.tray as unknown as FakeTray).menu[1].click();
  assert.equal(h.recorder.status, 'recording');
  (menus.tray as unknown as FakeTray).menu[2].click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(commands.at(-1), ['settings', 'computer-history']);
  indicator.set({ status: 'off' });
  assert.equal(t.destroyed, true);
  assert.equal(menus.tray, null);
  menus.setTray(true);
  assert.equal((menus.tray as unknown as FakeTray).tooltip, 'MoPilot');
  h.act((r: any) => r.setEnabled(false));
});

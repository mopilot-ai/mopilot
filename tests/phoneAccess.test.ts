// Mobile Remote's gate (electron/remote/phoneAccess.cjs): every signed-in account while the remote.enabled kill switch is on (no invite since it left the closed alpha), and every consumer (settings IPC, runtime, always-on) reading that one answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withPlatform } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const phone = require('../electron/remote/phoneAccess.cjs');
const { MomoAccess } = require('../electron/momo/access.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');
const { openMobileRemote } = require('../electron/app/mobileRemote.cjs');
const { openAlwaysOn } = require('../electron/app/alwaysOnWiring.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-access-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => fs.mkdtempSync(path.join(dir, `d${++n}-`));
const T = 1_000_000_000;
const invited = { signedIn: true, user: { id: 'u1', features: [] as string[] }, checkedAt: T };
const signedOut = { signedIn: false, user: null };
const open = (o: any = {}) => phone.openPhoneAccess({ dir: fresh(), refresh: () => {}, flagOn: () => true, ...o });

test('a closed gate before it is opened, and the feature and switch it follows', async () => {
  phone.recomputePhoneAccess();
  assert.equal(phone.phoneAccess(), false);
  assert.equal(phone.FEATURE, null, 'no invite');
  assert.equal(phone.FLAG, 'remote.enabled');
});

test('every signed-in account opens it, whatever its invites, and an old cached no is not honoured; sign-out closes it', async () => {
  const d = fresh();
  // the closed alpha's answer for an account it did not invite, cached a minute ago
  fs.writeFileSync(path.join(d, 'phone-access.json'), JSON.stringify({ userId: 'u1', allowed: false, at: T - 60_000 }));
  const heard: boolean[] = [];
  const g = open({ dir: d, broadcast: (a: boolean) => void heard.push(a) });
  assert.equal(g instanceof MomoAccess, true);
  phone.updatePhoneAccess({ ...invited, checkedAt: null });
  assert.equal(phone.phoneAccess(), true, 'signed in, no fresh answer: the old no is not read');
  phone.updatePhoneAccess({ ...invited, user: { id: 'u1', features: ['momo', 'host'] } });
  assert.equal(phone.phoneAccess(), true, 'other invites');
  phone.updatePhoneAccess(invited);
  assert.equal(phone.phoneAccess(), true, 'none at all');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'phone-access.json'), 'utf8')), { userId: 'u1', allowed: true, at: T });
  phone.updatePhoneAccess(signedOut);
  assert.equal(phone.phoneAccess(), false, 'signed out');
  assert.deepEqual(heard, [true, false]);
  g.dispose();
});

test('the kill switch removes it live and the gate stays shut until the switches load', async () => {
  let flag = true;
  const g = open({ flagOn: () => flag, waitForFlags: true });
  phone.updatePhoneAccess(invited);
  assert.equal(phone.phoneAccess(), false, 'waiting for the switches');
  phone.recomputePhoneAccess();
  assert.equal(phone.phoneAccess(), true);
  flag = false;
  phone.recomputePhoneAccess();
  assert.equal(phone.phoneAccess(), false);
  g.dispose();
});

test('the default kill switch is remote.enabled itself', async () => {
  const g = phone.openPhoneAccess({ dir: fresh(), refresh: () => {} });
  phone.updatePhoneAccess(invited);
  // the shipped default is on (electron/platform/flags.cjs), so the invite alone decides
  assert.equal(phone.phoneAccess(), true);
  g.dispose();
});

test('services hear each change; one that throws stops no other, and an unsubscribed one hears nothing', async () => {
  const g = open();
  const heard: boolean[] = [];
  phone.onPhoneAccess(() => {
    throw new Error('boom');
  });
  const off = phone.onPhoneAccess((a: boolean) => void heard.push(a));
  phone.updatePhoneAccess(invited);
  assert.deepEqual(heard, [true]);
  off();
  phone.updatePhoneAccess({ signedIn: false, user: null });
  assert.deepEqual(heard, [true]);
  g.dispose();
});

test('signed out, nothing shows: the settings IPC says invisible and refuses every action', async () => {
  const g = open();
  const handles = new Map<string, any>();
  const listeners = new Map<string, any>();
  const ipc: any = { handle: (c: string, f: any) => handles.set(c, f), on: (c: string, f: any) => listeners.set(c, f), removeHandler() {} };
  register(ipc, { live: { mopilot: { creds: null }, remoteConsent: { enabled: () => true, set() {} } } });
  const sender: any = new (require('node:events').EventEmitter)();
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  const event: any = { sender, senderFrame: sender.mainFrame };
  listeners.get('remoteSettings:document')!(event);
  const token = event.returnValue;
  const call = (k: string, ...a: unknown[]) => handles.get(`remoteSettings:${k}`)!(event, token, ...a);
  phone.updatePhoneAccess(signedOut);
  assert.deepEqual(await call('state'), { visible: false });
  await assert.rejects(call('setEnabled', true), /unavailable/);
  assert.throws(() => call('begin'), /unavailable/);
  phone.updatePhoneAccess(invited);
  assert.equal((await call('state')).visible, true);
  g.dispose();
});

test('the runtime and the menu-bar agent read the same gate', async () => {
  const g = open();
  let options: any;
  openMobileRemote(
    { userData: '/tmp', live: { remoteConsent: { enabled: () => true }, mopilot: {} }, safeStorage: {}, fs: {} },
    (o: any) => {
      options = o;
      return { sync: async () => {} };
    },
  );
  assert.equal(options.flagOn, phone.phoneAccess);
  phone.updatePhoneAccess(signedOut);
  assert.equal(options.flagOn(), false);
  phone.updatePhoneAccess(invited);
  assert.equal(options.flagOn(), true);
  g.dispose();
});

test('always-on starts quietly only for a signed-in account', async () => {
  await withPlatform('darwin', async () => {
    const g = open();
    const app: any = {
      getPath: () => fresh(),
      getLoginItemSettings: () => ({ wasOpenedAtLogin: true }),
      setLoginItemSettings() {},
      on() {},
      dock: undefined,
    };
    const live: any = { remote: { running: false } };
    const alwaysOn = openAlwaysOn({
      app,
      menus: { refreshTray() {} },
      live,
      ignored: () => undefined,
      broadcastAll() {},
      electron: { BrowserWindow: { getAllWindows: () => [] }, powerSaveBlocker: undefined },
    });
    alwaysOn.set({ keepRunning: true, loginItem: true });
    phone.updatePhoneAccess(signedOut);
    assert.equal(alwaysOn.startsQuietly(), false, 'signed out');
    phone.updatePhoneAccess(invited);
    assert.equal(alwaysOn.startsQuietly(), true, 'signed in');
    alwaysOn.close();
    g.dispose();
  });
});

test('the login-item start decides on the cached answer before the account is read', async () => {
  const d = fresh();
  const file = path.join(d, 'phone-access.json');
  const at = (c: unknown) => (fs.writeFileSync(file, JSON.stringify(c)), phone.phoneAccessAtStart(d, () => T + 1000));
  assert.equal(phone.phoneAccessAtStart(d), false, 'no cache');
  fs.writeFileSync(file, '{not json');
  assert.equal(phone.phoneAccessAtStart(d), false, 'unreadable');
  assert.equal(at({ userId: 'u1', allowed: true, at: T }), true, 'signed in');
  // an alpha-era answer for an account it did not invite still means this Mac was signed in
  assert.equal(at({ userId: 'u1', allowed: false, at: T }), true, 'the alpha’s no');
  assert.equal(at({ allowed: true, at: T }), false, 'no account');
  assert.equal(at({ userId: 'u1', allowed: true, at: T + 5000 }), false, 'from the future');
  assert.equal(at({ userId: 'u1', allowed: true, at: T - 8 * 24 * 3600_000 }), false, 'older than a week');
  assert.equal(at(null), false, 'empty');
});

test('always-on follows the cached answer while the gate is still closed', async () => {
  await withPlatform('darwin', () => {
    const g = open();
    const d = fresh();
    fs.writeFileSync(path.join(d, 'phone-access.json'), JSON.stringify({ userId: 'u1', allowed: true, at: Date.now() }));
    const app: any = { getPath: () => d, getLoginItemSettings: () => ({ wasOpenedAtLogin: true }), setLoginItemSettings() {}, on() {} };
    const alwaysOn = openAlwaysOn({
      app,
      menus: { refreshTray() {} },
      live: { remote: { running: false } },
      ignored: () => undefined,
      broadcastAll() {},
      electron: { BrowserWindow: { getAllWindows: () => [] }, powerSaveBlocker: undefined },
    });
    alwaysOn.set({ keepRunning: true, loginItem: true });
    assert.equal(phone.phoneAccess(), false, 'the gate is not open yet');
    assert.equal(alwaysOn.startsQuietly(), true);
    alwaysOn.close();
    g.dispose();
  });
});

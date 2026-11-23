// Mobile Remote's always-on controller (electron/app/alwaysOn.cjs): opt-in switches, menu-bar item, Dock icon, login item and sleep blocker, over fakes for Electron and the remote runtime.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rig } from './support/alwaysOnRig.ts';

mock.timers.enable({ apis: ['setInterval'] });
after(() => mock.timers.reset());

test('every switch is off by default and nothing is touched: no login item, blocker, Dock change or timer', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.watchWindows();
  r.makeWindow().emit('closed');
  r.alwaysOn.sync();
  assert.deepEqual(r.alwaysOn.get().prefs, { keepRunning: false, loginItem: false, preventSleep: false, offered: false });
  assert.equal(r.alwaysOn.active, false);
  assert.deepEqual(r.log, []);
  assert.equal(r.remote.listeners(), 0);
  mock.timers.tick(60_000);
  assert.deepEqual(r.log, []);
});

test('the switches persist, ignore unknown keys and non-booleans, and a failed save leaves them where they were', () => {
  const r = rig();
  r.remote.start();
  const s = r.alwaysOn.set({ keepRunning: true, preventSleep: 'yes', other: true });
  assert.deepEqual(
    s.prefs,
    { keepRunning: true, loginItem: false, preventSleep: false, offered: true },
    'a switch the person moved counts as their choice',
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), s.prefs);
  assert.deepEqual(rig({ saved: s.prefs }).alwaysOn.get().prefs, s.prefs);
  assert.deepEqual(rig({ saved: { keepRunning: 'true', loginItem: 1 } }).alwaysOn.get().prefs, {
    keepRunning: false,
    loginItem: false,
    preventSleep: false,
    offered: true,
  });
  r.alwaysOn.set(undefined as any);
  fs.rmSync(r.file);
  fs.mkdirSync(r.file);
  assert.throws(() => r.alwaysOn.set({ keepRunning: false }));
  assert.equal(r.alwaysOn.get().prefs.keepRunning, true);
});

test('keep running needs the remote runtime: the app is active only while both are on', () => {
  const r = rig();
  r.alwaysOn.set({ keepRunning: true });
  assert.equal(r.alwaysOn.active, false, 'the remote switch is off');
  r.remote.start();
  r.alwaysOn.sync();
  assert.equal(r.alwaysOn.active, true);
  assert.equal(r.alwaysOn.get().remoteOn, true);
  r.remote.stop();
  r.alwaysOn.sync();
  assert.equal(r.alwaysOn.active, false);
  assert.equal(r.trays() > 0, true, 'the menu-bar item is redrawn when it comes and goes');
});

test('the Dock icon goes with the last window and comes back with the next one', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.watchWindows();
  const a = r.makeWindow();
  r.alwaysOn.set({ keepRunning: true });
  assert.deepEqual(r.log, []);
  a.visible = false;
  a.emit('hide');
  assert.deepEqual(r.log, ['dock:hide']);
  const b = r.makeWindow();
  assert.deepEqual(r.log, ['dock:hide', 'dock:show']);
  b.minimized = true;
  b.visible = false;
  b.emit('minimize');
  assert.equal(r.log.length, 2, 'a minimized window keeps the Dock icon');
  b.gone = true;
  b.emit('closed');
  assert.equal(r.log.at(-1), 'dock:hide');
  r.alwaysOn.set({ keepRunning: false });
  assert.equal(r.log.at(-1), 'dock:show', 'turning it off gives the Dock icon back');
});

test('without a Dock (other systems) or when showing it fails, nothing breaks', async () => {
  const none = rig({ dock: false });
  none.remote.start();
  none.alwaysOn.set({ keepRunning: true });
  assert.deepEqual(none.log, []);
  none.alwaysOn.surface();
  const r = rig();
  r.remote.start();
  r.app.dockShow = () => Promise.reject(new Error('no dock'));
  r.alwaysOn.set({ keepRunning: true });
  r.alwaysOn.surface();
  assert.deepEqual(r.log, ['dock:hide', 'dock:show']);
  r.app.dockShow = () => Promise.reject(new Error('no dock'));
  r.makeWindow();
  r.alwaysOn.watchWindows();
  r.alwaysOn.set({ keepRunning: false });
  await Promise.resolve();
});

test('surface brings the Dock icon back for the quit question only when it was hidden', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true });
  assert.equal(r.log.at(-1), 'dock:hide');
  r.alwaysOn.surface();
  assert.equal(r.log.at(-1), 'dock:show');
  r.alwaysOn.surface();
  assert.equal(r.log.filter((l) => l === 'dock:show').length, 1);
  mock.timers.tick(10_000);
  assert.equal(r.log.at(-1), 'dock:hide', 'a cancelled quit hides it again at the next look');
});

test('the login item is set only when asked for, only with keep running, and only a login item this switch made is cleared', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.set({ loginItem: true });
  assert.equal(r.app.login.openAtLogin, false, 'needs keep running');
  r.alwaysOn.set({ keepRunning: true });
  assert.equal(r.app.login.openAtLogin, true);
  r.alwaysOn.sync();
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('login')),
    ['login:true'],
  );
  r.alwaysOn.set({ loginItem: false });
  assert.equal(r.app.login.openAtLogin, false);
  // a login item the user made themselves is not ours to clear
  const own = rig();
  own.app.login.openAtLogin = true;
  own.remote.start();
  own.alwaysOn.set({ keepRunning: true });
  own.alwaysOn.set({ keepRunning: false });
  assert.equal(own.app.login.openAtLogin, true);
  assert.deepEqual(
    own.log.filter((l) => l.startsWith('login')),
    [],
  );
});

test('turning Mobile Remote off clears the login item the switch set, and the next start with it on sets it again', () => {
  const r = rig({ saved: { keepRunning: true, loginItem: true } });
  r.app.login.openAtLogin = true;
  r.alwaysOn.sync();
  assert.equal(r.app.login.openAtLogin, false, 'remote is not running: no background start for a feature that is off');
  r.remote.start();
  r.alwaysOn.sync();
  assert.equal(r.app.login.openAtLogin, true);
});

test('Linux has no login item: the switch is reported unsupported and never calls the API', () => {
  const r = rig({ platform: 'linux' });
  r.remote.start();
  const s = r.alwaysOn.set({ keepRunning: true, loginItem: true });
  assert.equal(s.loginItemSupported, false);
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('login')),
    [],
  );
  r.app.login.wasOpenedAtLogin = true;
  assert.equal(r.alwaysOn.startsQuietly(), false);
});

test('sleep is held off while plugged in with a phone paired, connected or not, and released when the last pair goes or the power does', () => {
  const r = rig();
  const blocks = () => r.log.filter((l) => l.includes('block'));
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true, preventSleep: true });
  assert.deepEqual(blocks(), [], 'no phone yet');
  r.remote.pair('p1', 'gone');
  assert.deepEqual(blocks(), ['block:prevent-app-suspension'], 'a phone away must be able to come back');
  r.remote.pair('p2');
  assert.equal(r.log.filter((l) => l === 'block:prevent-app-suspension').length, 1, 'one blocker for any number of phones');
  r.remote.unpair('p1');
  assert.equal(r.log.includes('unblock'), false);
  r.power.battery = true;
  r.power.emit('on-battery');
  assert.equal(r.log.at(-1), 'unblock', 'on battery the Mac sleeps as usual');
  r.power.battery = false;
  r.power.emit('on-ac');
  assert.equal(r.log.at(-1), 'block:prevent-app-suspension', 'plugged back in');
  r.remote.unpair('p2');
  assert.equal(r.log.at(-1), 'unblock', 'the last pair going releases it at once, not at the next poll');
  r.alwaysOn.close();
  assert.equal(r.power.listenerCount('on-ac') + r.power.listenerCount('on-battery'), 0, 'it stops listening on quit');
});

test('no power monitor counts as plugged in; offered is only the first pairing, and a file from before it counts as offered', () => {
  const r = rig({ blocker: false });
  r.remote.start();
  r.remote.pair('p');
  r.alwaysOn.set({ keepRunning: true, preventSleep: true });
  r.alwaysOn.close();
  assert.equal(rig({ saved: { keepRunning: false } }).alwaysOn.get().prefs.offered, true);
  const fresh = rig();
  assert.equal(fresh.alwaysOn.get().prefs.offered, false);
  assert.equal(fresh.alwaysOn.set({ offered: true }).prefs.offered, true);
  assert.equal(rig().alwaysOn.set({ preventSleep: false }).prefs.offered, true, 'turning one off is a choice too');
  assert.equal(rig().alwaysOn.set({ other: true } as any).prefs.offered, false, 'a patch that moves nothing is not');
  assert.equal(fresh.alwaysOn.get().active, false, 'offered alone turns nothing on');
});

test('the blocker is off with its switch, with Mobile Remote, and where Electron has none', () => {
  const r = rig();
  r.makeWindow();
  r.remote.start();
  r.remote.pair('p');
  r.alwaysOn.set({ keepRunning: true, preventSleep: true });
  assert.equal(r.log.at(-1), 'block:prevent-app-suspension');
  r.alwaysOn.set({ preventSleep: false });
  assert.equal(r.log.at(-1), 'unblock');
  r.alwaysOn.set({ preventSleep: true });
  r.remote.stop();
  r.alwaysOn.sync();
  assert.equal(r.log.at(-1), 'unblock');
  const bare = rig({ blocker: false });
  bare.remote.start();
  bare.remote.pair('p');
  bare.alwaysOn.set({ keepRunning: true, preventSleep: true });
  bare.alwaysOn.close();
  assert.deepEqual(
    bare.log.filter((l) => l.includes('block')),
    [],
  );
});

test('a blocker Electron already dropped is not stopped twice', () => {
  const r = rig();
  r.remote.start();
  r.remote.pair('p');
  r.alwaysOn.set({ keepRunning: true, preventSleep: true });
  const before = r.log.length;
  // (the fake keeps ids in a set: forget it as the system would)
  r.log.length = 0;
  r.alwaysOn.close();
  assert.deepEqual(r.log, ['unblock']);
  assert.ok(before > 0);
  r.alwaysOn.close();
  assert.deepEqual(r.log, ['unblock']);
});

test('the poll runs only while a switch is on, follows a restarted runtime, and ends with close', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true });
  assert.equal(r.remote.listeners(), 1);
  r.remote.stop();
  r.alwaysOn.sync();
  assert.equal(r.remote.listeners(), 0);
  r.remote.start();
  r.alwaysOn.sync();
  assert.equal(r.remote.listeners(), 1);
  r.alwaysOn.close();
  assert.equal(r.remote.listeners(), 0);
  r.alwaysOn.close();
  r.alwaysOn.set({ keepRunning: false });
  assert.equal(r.remote.listeners(), 0);
});

test('every change reaches the windows once, with the paired-phone state', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true });
  r.alwaysOn.sync();
  const n = r.changes.length;
  r.remote.pair('p');
  assert.equal(r.changes.length, n + 1);
  assert.deepEqual({ paired: r.changes.at(-1).paired, connected: r.changes.at(-1).connected }, { paired: 1, connected: true });
});

test('the poll refreshes phone details when names or individual connections change without changing the aggregate', () => {
  const r = rig();
  r.remote.start();
  r.remote.pair('a');
  r.remote.pair('b');
  r.alwaysOn.set({ keepRunning: true });
  const before = r.trays();
  // No pair-change notification: presence and names can change independently of the channel's pair set.
  r.live.remote.presence.isOnline = (id: string) => id === 'a';
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 1, 'two connected becoming one must refresh even though connected stays true');
  r.live.remote.presence.isOnline = (id: string) => id === 'b';
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 2, 'the other phone connecting must refresh at the same count');
  r.live.remote.devices.list = () => [
    { id: 'b', pairId: 'b', name: 'Renamed phone' },
    { id: 'a', pairId: 'a', name: 'a' },
  ];
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 3);
  assert.equal(r.alwaysOn.trayItems()[0].submenu[1].label, 'Renamed phone — Connected');
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 3, 'unchanged snapshots do not rebuild the menu');
  r.alwaysOn.close();
});

test('an empty phone list refreshes the tray when storage locks and recovers', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.set({ keepRunning: true });
  const before = r.trays();
  r.live.remote.devices.locked = true;
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 1, 'an uncertain first pairing must replace the Connect offer with recovery');
  assert.equal(r.alwaysOn.trayItems()[0].label, 'Phones · Needs attention');
  r.live.remote.devices.locked = false;
  mock.timers.tick(10_000);
  assert.equal(r.trays(), before + 2);
  assert.equal(r.alwaysOn.trayItems()[0].label, 'Connect a phone…');
  r.alwaysOn.close();
});

test('the menu-bar phone item offers pairing or a compact connection count', () => {
  const r = rig();
  r.remote.start();
  const line = () => r.alwaysOn.trayItems()[0].label;
  assert.equal(line(), 'Connect a phone…');
  let connects = 0;
  const [offer] = r.alwaysOn.trayItems(() => connects++);
  assert.equal(offer.label, 'Connect a phone…');
  offer.click();
  assert.equal(connects, 1, 'with no phone paired the first line opens Connect your phone');
  r.remote.pair('a', 'gone');
  assert.equal(line(), 'Phones · 0 connected');
  r.remote.pair('b');
  assert.equal(line(), 'Phones · 1 connected');
  assert.equal(r.alwaysOn.trayItems()[1].type, 'separator');
  r.remote.pair('c', 'gone');
  r.remote.unpair('b');
  assert.equal(line(), 'Phones · 0 connected');
});

test('a login-item start is quiet only with the remote switch, both user switches and the OS saying it was opened at login', () => {
  const r = rig({ saved: { keepRunning: true, loginItem: true } });
  assert.equal(r.alwaysOn.startsQuietly(), false, 'started by the user');
  r.app.login.wasOpenedAtLogin = true;
  assert.equal(r.alwaysOn.startsQuietly(), true);
  r.flag.on = false;
  assert.equal(r.alwaysOn.startsQuietly(), false, 'remote.enabled is off');
  r.flag.on = true;
  assert.equal(rig({ saved: { keepRunning: true } }).alwaysOn.startsQuietly(), false);
});

test('a failure inside the controller is noted and never thrown into Electron', () => {
  const r = rig();
  r.remote.start();
  r.app.getLoginItemSettings = () => {
    throw new Error('login item API failed');
  };
  assert.doesNotThrow(() => r.alwaysOn.set({ keepRunning: true, loginItem: true }));
  assert.equal(r.alwaysOn.get().prefs.loginItem, true);
});

test('a switch turned on after the runtime was already seen still listens for pairs, so the last pair going releases the blocker at once', () => {
  const r = rig();
  r.remote.start();
  r.alwaysOn.sync();
  assert.equal(r.remote.listeners(), 0, 'nothing is on: nothing listens');
  r.remote.pair('p');
  r.alwaysOn.set({ keepRunning: true, preventSleep: true });
  assert.equal(r.remote.listeners(), 1);
  r.remote.unpair('p');
  assert.equal(r.log.at(-1), 'unblock');
});

// The wait for a computer-use permission the user is turning on in System Settings (#2528, electron/capabilities/permissionWatch.cjs, platform/helperOffline.cjs, computerUse.cjs): Request or Open Settings that leaves a permission off is watched, through a helper launched just for each read, and announced (computer:changed) when it goes on, Screen Recording included; Open Settings quits an idle helper first, so System Settings has no running app to ask to Quit & Reopen, and leaves a busy one alone; switching computer use off or stopping ends the wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { rig } from './support/computer-use-setup-rig.ts';

const fast = { intervalMs: 0, timeoutMs: 1000, sleep: () => new Promise((r) => setTimeout(r, 2)) };
const settle = () => new Promise((r) => setTimeout(r, 80));
const changes = (r: any) => r.log.filter((l: any[]) => l[0] === 'broadcast' && l[1] === 'computer:changed').length;

/** The helper's launch for a read, as `open -W` does it: the grants it answers are `grants.now`, written where --out says. */
function offline(helper: any, grants: { now: Record<string, boolean> }) {
  const launches: string[][] = [];
  helper.spawn = (_cmd: string, args: string[]) => {
    launches.push(args);
    const child: any = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(grants.now));
      child.emit('exit', 0);
    });
    return child;
  };
  return launches;
}

test('a permission left off after Request or Open Settings is read by a launched helper and announced when it goes on, Screen Recording too (#2528)', async () => {
  const opened: string[] = [];
  const r = rig({ options: { permissionWatch: fast }, openExternal: async (u: string) => opened.push(u) });
  const { helper } = r.runtime;
  Object.defineProperty(helper, 'installed', { configurable: true, get: () => true });
  const grants = { now: { accessibility: false, screenRecording: false, inputMonitoring: false } as Record<string, boolean> };
  const launches = offline(helper, grants);
  helper.start = async () => {};
  helper.requestPermission = async () => ({ accessibility: false });
  // Request leaves it off: main watches, and says so when it goes on
  assert.equal(await r.ipc('computer:requestPermission', 'accessibility'), false);
  const before = changes(r);
  grants.now.accessibility = true;
  await settle();
  assert.equal(changes(r), before + 1);
  assert.ok(launches.length > 0 && launches.every((a) => a.includes('--permissions-status')), 'each read launches the helper for it');
  // Open Settings through main's own pane open watches too, Screen Recording as well
  for (const [kind, url] of [
    ['inputMonitoring', 'Privacy_ListenEvent'],
    ['screenRecording', 'Privacy_ScreenCapture'],
  ] as const) {
    grants.now = { accessibility: false, screenRecording: false, inputMonitoring: false };
    const n = changes(r);
    assert.equal(await r.ipc('computer:openSettings', kind), true);
    assert.match(opened.at(-1)!, new RegExp(url));
    grants.now[kind] = true;
    await settle();
    assert.equal(changes(r), n + 1, kind);
  }
  // a permission that is on after Request starts no watch
  const quiet = changes(r);
  helper.requestPermission = async () => ({ accessibility: true });
  assert.equal(await r.ipc('computer:requestPermission', 'accessibility'), true);
  await settle();
  assert.equal(changes(r), quiet + 1, 'only the Request broadcast');
});

test('Open Settings quits an idle running helper first, and a busy one is left running and still opens the pane through itself', async () => {
  const r = rig({ options: { permissionWatch: { ...fast, timeoutMs: 0 } }, openExternal: async () => {} });
  const { helper } = r.runtime;
  const stopped: number[] = [];
  const realStop = helper.stop.bind(helper);
  helper.stop = () => (stopped.push(1), realStop());
  const opened: string[] = [];
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  helper.openSettings = async (kind: string) => (opened.push(kind), { opened: false });
  // idle: it quits, then main opens the pane
  assert.equal(await r.ipc('computer:openSettings', 'accessibility'), true);
  assert.equal(stopped.length, 1);
  // busy (a call in flight): not stopped; the helper opens the pane itself
  helper.pending.set(1, {});
  helper.openSettings = async (kind: string) => (opened.push(kind), { opened: true });
  assert.equal(await r.ipc('computer:openSettings', 'screenRecording'), true);
  assert.equal(stopped.length, 1, 'nothing it is doing is cut off');
  assert.deepEqual(opened, ['accessibility', 'screenRecording'], 'the idle one asked first (and left the pane to main)');
  helper.pending.clear();
  // not running: nothing to quit
  Object.defineProperty(helper, 'running', { configurable: true, get: () => false });
  assert.equal(await r.ipc('computer:openSettings', 'accessibility'), true);
  assert.equal(stopped.length, 1);
});

test('the runtime releases the helper for MoMo: stopped when idle, busy while a chat holds the Mac, none when it is not running', async () => {
  const r = rig({ options: { permissionWatch: { ...fast, timeoutMs: 0 } } });
  const { helper } = r.runtime;
  let stops = 0;
  helper.stop = () => void stops++;
  assert.equal(r.runtime.releaseHelper(), 'none');
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  assert.equal(r.runtime.releaseHelper(), 'stopped');
  assert.equal(stops, 1);
  helper.pending.set(1, {});
  assert.equal(r.runtime.releaseHelper(), 'busy');
  assert.equal(stops, 1);
  helper.pending.clear();
  // the grants as a launched helper reads them
  const launches = offline(helper, { now: { calendar: 'granted', reminders: 'denied' } as any });
  assert.deepEqual(await r.runtime.offlineStatus('eventkit'), { calendar: 'granted', reminders: 'denied' });
  assert.ok(launches[0].includes('--eventkit-status'));
});

test('a wait for a permission ends when computer use is switched off or stopped (#2528)', async () => {
  const r = rig({ options: { permissionWatch: { ...fast, timeoutMs: 5000 } }, openExternal: async () => {} });
  const { helper } = r.runtime;
  const grants = { now: { accessibility: false } as Record<string, boolean> };
  offline(helper, grants);
  await r.ipc('computer:openSettings', 'accessibility');
  r.flags['shared.computerUse.enabled'] = false;
  r.runtime.sync();
  r.runtime.stop();
  const before = changes(r);
  grants.now.accessibility = true;
  await settle();
  assert.equal(changes(r), before, 'nothing is announced after the stop');
});

test('with a fake helper on a socket (no app to launch) the grants are read through it', async () => {
  const r = rig({ options: { permissionWatch: { ...fast, timeoutMs: 1000 } }, openExternal: async () => {} });
  const { helper } = r.runtime;
  const asked: string[] = [];
  helper.connectTo = '/tmp/fake.sock';
  helper.call = async (method: string) => (
    asked.push(method), method === 'eventkit.status' ? { calendar: 'granted' } : { accessibility: true }
  );
  assert.deepEqual(await r.runtime.offlineStatus('eventkit'), { calendar: 'granted' });
  const before = changes(r);
  await r.ipc('computer:openSettings', 'accessibility');
  await settle();
  assert.equal(changes(r), before + 1);
  assert.deepEqual([...new Set(asked)].sort(), ['eventkit.status', 'permissions.status']);
});

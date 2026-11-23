// Computer History in main (#1363, electron/computerHistory/service.cjs and indicator.cjs): the helper sample reads only allowed apps, a lock, sleep and quit suspend the recorder (a cancelled quit resumes it), the indicator follows the status, and previews, days and app candidates.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fakeSafe, manualTimers } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const {
  createComputerHistory,
  startComputerHistory,
  appComputerHistory,
  helperSample,
  QUIT_GRACE_MS,
} = require('../electron/computerHistory/service.cjs');
const indicator = require('../electron/computerHistory/indicator.cjs');
const { DEFAULT_SETTINGS, BUILT_IN_BROWSER } = require('../electron/computerHistory/policy.cjs');
const { dayKey } = require('../electron/computerHistory/segments.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const userData = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-svc-'));
  dirs.push(d);
  return d;
};
const notes = { bundleId: 'com.apple.Notes', name: 'Notes', title: 'Plan', secure: false };

function fakeHelper(reply: any = notes) {
  const calls: any[] = [];
  return {
    calls,
    call: async (method: string, params: any, o: any) => {
      calls.push([method, params, o]);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(method) : reply;
    },
    idleSeconds: async () => 0,
  };
}

/** A history with its own fakes; `allow` turns it on with Notes, Chrome and the built-in browser allowed. */
function make(o: { helper?: any; locked?: boolean; allow?: boolean } = {}) {
  const dir = userData();
  if (o.allow !== false) {
    fs.mkdirSync(path.join(dir, 'computer-history'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'computer-history', 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        enabled: true,
        apps: [{ bundleId: 'com.apple.Notes', name: 'Notes' }, { bundleId: 'com.google.Chrome', name: 'Chrome' }, BUILT_IN_BROWSER],
        sites: ['example.com'],
      }),
    );
  }
  const pm = Object.assign(new EventEmitter(), { getSystemIdleState: () => (o.locked ? 'locked' : 'active') });
  const app = new EventEmitter();
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers = {
    setTimeout: ((fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timeouts.push(t);
      return t;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((t: any) => void (t.cleared = true)) as unknown as typeof clearTimeout,
  };
  const intervals = manualTimers();
  const broadcasts: any[] = [];
  const helper = o.helper === undefined ? fakeHelper() : o.helper;
  const h = createComputerHistory({
    userData: dir,
    safeStorage: fakeSafe(),
    helper: () => helper,
    userDeny: () => [],
    powerMonitor: pm,
    app,
    broadcast: (s: any) => broadcasts.push(s),
    timers,
    recorder: { timers: intervals },
  });
  return { h, pm, app, timeouts, intervals, broadcasts, helper, dir };
}

test('the helper is asked only about the allowed apps, and for page addresses only of allowed browsers', async () => {
  const helper = fakeHelper();
  const settings = { ...DEFAULT_SETTINGS, apps: [{ bundleId: 'com.apple.Notes' }, { bundleId: 'com.google.Chrome' }, BUILT_IN_BROWSER] };
  assert.deepEqual(await helperSample(helper, settings), notes);
  assert.deepEqual(helper.calls[0][0], 'activity.sample');
  assert.deepEqual(helper.calls[0][1], { apps: ['com.apple.Notes', 'com.google.Chrome'], browsers: ['com.google.Chrome'] });
  assert.ok(helper.calls[0][2].timeoutMs > 0);
});

test('a helper without Accessibility, a missing helper and a failing one become clear reasons', async () => {
  assert.deepEqual(await helperSample(fakeHelper({ bundleId: 'x', trusted: false }), DEFAULT_SETTINGS), { error: 'needs-permission' });
  assert.deepEqual(await helperSample(null, DEFAULT_SETTINGS), { error: 'unavailable' });
  const failed = await helperSample(fakeHelper(new Error('helper_exited')), DEFAULT_SETTINGS);
  assert.equal(failed.error, 'unavailable');
  assert.match(failed.cause.message, /helper_exited/, 'the cause goes back for the recorder to record once');
  assert.equal(await helperSample(fakeHelper(null), DEFAULT_SETTINGS), null);
});

test('it records with no window open, and the indicator and windows follow the status', async () => {
  const { h, intervals, broadcasts } = make();
  assert.equal(h.recorder.status, 'recording');
  assert.equal(indicator.get().status, 'recording');
  assert.equal(indicator.recording(), true);
  intervals.fire();
  await new Promise((r) => setImmediate(r));
  assert.ok(h.recorder.open);
  h.act((r: any) => r.pause());
  assert.equal(indicator.get().status, 'paused');
  assert.equal(indicator.recording(), false);
  assert.ok(broadcasts.some((s) => s.status === 'paused'));
});

test('without a helper the recorder says it is waiting for one, never that it records', async () => {
  const { h, intervals } = make({ helper: null });
  intervals.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.recorder.status, 'unavailable');
});

test('a lock, sleep and quit suspend at once; unlock and wake resume; a quit that did not happen resumes after the grace', () => {
  const { h, pm, app, timeouts } = make();
  pm.emit('lock-screen');
  assert.equal(h.recorder.status, 'suspended');
  pm.emit('unlock-screen');
  pm.emit('suspend');
  assert.equal(h.recorder.status, 'suspended');
  pm.emit('resume');
  assert.equal(h.recorder.status, 'recording');
  app.emit('before-quit');
  assert.equal(h.recorder.status, 'suspended');
  assert.equal(timeouts[0].ms, QUIT_GRACE_MS);
  app.emit('before-quit');
  assert.equal(timeouts[0].cleared, true, 'a second quit restarts the grace');
  timeouts[1].fn();
  assert.equal(h.recorder.status, 'recording', 'the quit was cancelled');
  app.emit('before-quit');
  app.emit('will-quit');
  assert.equal(timeouts[2].cleared, true);
  assert.equal(h.recorder.status, 'suspended');
  app.emit('will-quit');
  assert.equal(h.recorder.status, 'suspended');
});

test('a screen already locked at start suspends from the first moment; an unreadable lock state does not', () => {
  assert.equal(make({ locked: true }).h.recorder.status, 'suspended');
  const dir = userData();
  const h = createComputerHistory({
    userData: dir,
    safeStorage: fakeSafe(),
    helper: () => null,
    powerMonitor: Object.assign(new EventEmitter(), {
      getSystemIdleState: () => {
        throw new Error('no session');
      },
    }),
  });
  assert.equal(h.recorder.status, 'off');
  const bare = createComputerHistory({ userData: userData(), safeStorage: null, helper: () => null });
  assert.equal(bare.recorder.status, 'off');
  assert.deepEqual(bare.memories().memories, []);
  assert.equal(bare.candidates([{ bundleId: 'com.apple.Notes' }])[0].excluded, null, 'no deny list given');
});

test('memories for a preview: today by default, only real days, only what the user chose', async () => {
  const { h, intervals } = make({
    helper: fakeHelper((m: string) => (m === 'activity.sample' ? notes : null)),
  });
  intervals.fire();
  await new Promise((r) => setImmediate(r));
  const today = h.memories();
  assert.equal(today.memories.length, 1);
  assert.match(today.text, /Notes · "Plan"/);
  assert.match(today.block, /^<sage-computer-history>/);
  assert.equal(today.unreadable, 0);
  assert.deepEqual(h.memories({ days: ['../x', 3] }).memories, []);
  assert.deepEqual(h.memories({ days: [dayKey(Date.now())], apps: ['com.apple.TextEdit', 7] }).memories, []);
  assert.equal(h.memories({ days: [dayKey(Date.now())], apps: 'all' }).memories.length, 1);
  assert.deepEqual(h.days(), [dayKey(Date.now())], 'the open entry counts');
  h.recorder.pending = [
    {
      bundleId: 'com.apple.Notes',
      app: 'Notes',
      title: 'x',
      start: new Date(2026, 0, 2).getTime(),
      end: new Date(2026, 0, 2).getTime() + 1,
    },
  ];
  assert.ok(h.days().includes('2026-01-02'), 'an entry still waiting to be written counts');
  h.act((r: any) => r.pause());
  assert.ok(h.days().includes(dayKey(Date.now())));
  assert.equal(h.store.listDays().length, 2);
});

test('app candidates say which apps can never be recorded; act reports failures with the state', () => {
  const { h } = make();
  assert.deepEqual(
    h.candidates([{ bundleId: 'com.apple.Notes', name: 'Notes' }, { bundleId: 'com.1password.1password' }, null, { bundleId: '' }]),
    [
      { bundleId: 'com.apple.Notes', name: 'Notes', excluded: null },
      { bundleId: 'com.1password.1password', name: 'com.1password.1password', excluded: 'password manager' },
    ],
  );
  assert.deepEqual(h.candidates(undefined), []);
  const refused = h.act((r: any) => r.allowSite('chase.com'));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /never records/);
  assert.ok(refused.state);
  const failed = h.act(() => {
    throw new Error('disk full');
  });
  assert.deepEqual([failed.ok, failed.error], [false, 'disk full']);
  assert.equal(h.act(() => undefined).ok, true);
  const ex = h.exclusions();
  assert.ok(ex.apps.some((a: { reason: string }) => a.reason === 'password manager'));
  assert.ok(ex.healthSites.includes('mychart.com'));
});

test('one Computer History per app run', () => {
  assert.equal(appComputerHistory(), null);
  const o = { userData: userData(), safeStorage: fakeSafe(), helper: () => null };
  const a = startComputerHistory(o);
  assert.equal(startComputerHistory(o), a);
  assert.equal(appComputerHistory(), a);
});

test('the indicator tells only changes, and unsubscribing stops them', () => {
  indicator.set({ status: 'off' });
  const seen: string[] = [];
  const off = indicator.subscribe((s: { status: string }) => seen.push(s.status));
  indicator.set({ status: 'paused' });
  indicator.set({ status: 'paused' });
  indicator.set({ status: 'off' });
  off();
  indicator.set({ status: 'recording' });
  assert.deepEqual(seen, ['paused', 'off']);
  assert.equal(indicator.recording({ status: 'store-unavailable' }), true);
  assert.equal(indicator.recording({ status: 'suspended' }), false);
});

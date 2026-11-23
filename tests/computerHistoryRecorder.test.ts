// Computer History's recorder (#1363, electron/computerHistory/recorder.cjs) over a real encrypted store: one sample at a time, a sample in flight dropped by Pause, a lock, sleep, quit, a settings change or Delete all, entries written as they close, failures shown and retried, and nothing recorded while off, paused, idle or locked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, manualTimers, deferred } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { Recorder, IDLE_LIMIT_S, MAX_PENDING, FAILURE_TEXT } = require('../electron/computerHistory/recorder.cjs');
const { HistoryStore } = require('../electron/computerHistory/store.cjs');
const { DEFAULT_SETTINGS } = require('../electron/computerHistory/policy.cjs');
const { SAMPLE_MS } = require('../electron/computerHistory/segments.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const T0 = new Date(2026, 9, 18, 14, 0).getTime();
const notes = (title = 'Plan') => ({ bundleId: 'com.apple.Notes', name: 'Notes', title, secure: false });

function setup(
  o: { settings?: object; sample?: (s: any) => Promise<unknown>; safe?: any; idle?: () => Promise<number>; locked?: () => boolean } = {},
) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rec-'));
  dirs.push(d);
  const store = new HistoryStore({ dir: path.join(d, 'computer-history'), safeStorage: o.safe ?? fakeSafe() });
  store.writeSettings({ ...DEFAULT_SETTINGS, enabled: true, apps: [{ bundleId: 'com.apple.Notes', name: 'Notes' }], ...o.settings });
  const timers = manualTimers();
  let now = T0;
  const states: any[] = [];
  const seen: any[] = [];
  const rec = new Recorder({
    store,
    sample: o.sample ?? (async (s: any) => (seen.push(s), notes())),
    idleSeconds: o.idle ?? (async () => 0),
    locked: o.locked,
    onChange: (s: any) => states.push(s),
    now: () => now,
    timers,
  });
  return {
    store,
    rec,
    timers,
    states,
    seen,
    advance: (ms = SAMPLE_MS) => (now += ms),
    /** One interval: the time moves a sample on and the tick runs to its end. */
    step: async (ms = SAMPLE_MS) => {
      now += ms;
      await rec.tick();
    },
    written: () => store.listDays().flatMap((day: string) => store.readDay(day).entries),
  };
}

test('off by default: no timer and nothing sampled until it is turned on', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rec-'));
  dirs.push(d);
  const store = new HistoryStore({ dir: d, safeStorage: fakeSafe() });
  let sampled = 0;
  const timers = manualTimers();
  const rec = new Recorder({ store, sample: async () => (sampled++, notes()), idleSeconds: async () => 0, timers });
  assert.equal(rec.status, 'off');
  assert.equal(rec.running, false);
  await rec.tick();
  assert.equal(sampled, 0);
  rec.setEnabled(true);
  assert.equal(rec.status, 'recording');
  assert.equal(timers.live.size, 1);
  timers.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(sampled, 1);
});

test('samples of one activity grow one entry, written once it closes; the open entry reads back before that', async () => {
  const { rec, step, written, seen } = setup();
  await step();
  await step();
  assert.equal(written().length, 0);
  assert.equal(rec.entries(['2026-10-18']).entries.length, 1, 'the open entry is part of the day already');
  assert.deepEqual(seen[0].apps, [{ bundleId: 'com.apple.Notes', name: 'Notes' }], 'the sample source gets the allow list');
  rec.pause();
  assert.equal(rec.status, 'paused');
  assert.equal(rec.running, false);
  const [e] = written();
  assert.equal(e.title, 'Plan');
  assert.equal(e.end - e.start, 2 * SAMPLE_MS);
  rec.resume();
  assert.equal(rec.status, 'recording');
});

test('A1: a tick while one is in flight is skipped, so two samples never race', async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const { rec } = setup({ sample: () => (calls++, gate.promise) });
  const first = rec.tick();
  await rec.tick();
  assert.equal(calls, 1);
  gate.resolve(notes());
  await first;
  assert.equal(rec.busy, false);
});

for (const [name, stop] of [
  ['Pause', (r: any) => r.pause()],
  ['turning it off', (r: any) => r.setEnabled(false)],
  ['a screen lock', (r: any) => r.suspend('locked')],
  ['sleep', (r: any) => r.suspend('asleep')],
  ['quit', (r: any) => r.dispose()],
  ['an allow-list change', (r: any) => r.removeApp('com.apple.Notes')],
  ['Delete all', (r: any) => r.deleteAll()],
] as const) {
  test(`A2/A3: a sample still in flight when ${name} happens is dropped when it lands`, async () => {
    const gate = deferred<unknown>();
    const called = deferred();
    const { rec, written } = setup({ sample: () => (called.resolve(undefined), gate.promise) });
    const pending = rec.tick();
    await called.promise;
    stop(rec);
    gate.resolve(notes('Taken after the stop'));
    await pending;
    assert.equal(rec.open, null);
    assert.deepEqual(written(), []);
  });
}

test('A2: an idle read still in flight when the generation moves starts no sample', async () => {
  const idle = deferred<number>();
  let sampled = 0;
  const { rec } = setup({ idle: () => idle.promise, sample: async () => (sampled++, notes()) });
  const pending = rec.tick();
  rec.pause();
  idle.resolve(0);
  await pending;
  assert.equal(sampled, 0);
});

test('A3: a sample source that throws after a stop changes nothing; before one it shows unavailable', async () => {
  const gate = deferred<unknown>();
  const called = deferred();
  const { rec } = setup({ sample: () => (called.resolve(undefined), gate.promise) });
  const p = rec.tick();
  await called.promise;
  rec.pause();
  gate.reject(new Error('socket closed'));
  await p;
  assert.equal(rec.error, null);
  rec.resume();
  rec.sampleNow = async () => {
    throw new Error('socket closed');
  };
  await rec.tick();
  assert.equal(rec.status, 'unavailable');
  assert.equal(rec.error, FAILURE_TEXT.unavailable, 'the raw error goes to diagnostics, not to the user');
});

test('A5: lock, sleep and quit suspend until each is over; a Pause by the user survives an unlock', async () => {
  const { rec, step, written } = setup();
  await step();
  rec.suspend('locked');
  rec.suspend('locked');
  assert.equal(rec.status, 'suspended');
  assert.equal(written().length, 1, 'what was recorded before the lock is written');
  rec.suspend('asleep');
  rec.wake('locked');
  assert.equal(rec.status, 'suspended', 'still asleep');
  rec.wake('asleep');
  rec.wake('asleep');
  assert.equal(rec.status, 'recording');
  rec.pause();
  rec.suspend('locked');
  rec.wake('locked');
  assert.equal(rec.status, 'paused');
  assert.deepEqual(rec.state.suspended, []);
});

test('nothing is recorded while the screen is locked, the user is idle or the sample is dropped by policy', async () => {
  let locked = true;
  let idle = 0;
  const samples: unknown[] = [];
  const { rec, step, written } = setup({
    locked: () => locked,
    idle: async () => idle,
    sample: async () => samples.shift() ?? notes(),
  });
  await step();
  assert.equal(rec.open, null, 'locked');
  locked = false;
  await step();
  assert.ok(rec.open);
  idle = IDLE_LIMIT_S;
  await step();
  assert.equal(rec.open, null, 'idle closes the entry');
  assert.equal(written().length, 1);
  idle = Number.NaN;
  await step();
  assert.equal(rec.open, null, 'an unreadable idle time counts as idle');
  idle = 0;
  samples.push(
    { ...notes(), secure: true },
    { bundleId: 'com.1password.1password', name: '1P', title: 'Vault', secure: false },
    false,
    'junk',
  );
  for (let i = 0; i < 4; i++) await step();
  assert.equal(rec.open, null);
  assert.equal(written().length, 1);
});

test('the helper cannot claim the built-in browser: its sample is always an app sample', async () => {
  const { rec, step } = setup({
    settings: { apps: [{ bundleId: 'mopilot:built-in-browser', name: 'Built-in browser' }], sites: ['example.com'] },
    sample: async () => ({
      bundleId: 'mopilot:built-in-browser',
      name: 'x',
      title: 'x',
      secure: false,
      url: 'https://example.com/',
      source: 'iab',
    }),
  });
  await step();
  assert.equal(rec.open, null);
});

test('permission and helper failures show in the state and clear on the next good sample', async () => {
  const replies: unknown[] = [{ error: 'needs-permission' }, { error: 'needs-permission' }, { error: 'unavailable' }];
  const { rec, step } = setup({ sample: async () => replies.shift() ?? notes() });
  await step();
  assert.equal(rec.status, 'needs-permission');
  assert.match(rec.state.error, /Accessibility/);
  const changes = rec.onChange;
  let calls = 0;
  rec.onChange = (s: unknown) => (calls++, changes(s));
  await step();
  assert.equal(calls, 0, 'the same failure again is no change');
  await step();
  assert.equal(rec.status, 'unavailable');
  await step();
  assert.equal(rec.status, 'recording');
  assert.equal(rec.error, null);
  rec.setEnabled(false);
  assert.equal(rec.status, 'off');
});

test('W2: a write the store refuses keeps the entries, shows it, and writes them with the next one', async () => {
  const safe = fakeSafe();
  let available = false;
  const { rec, step, written } = setup({ safe: { ...safe, isEncryptionAvailable: () => available } });
  await step();
  rec.pause();
  assert.equal(rec.status, 'paused');
  assert.equal(rec.pending.length, 1);
  rec.resume();
  assert.equal(rec.errorStatus, 'store-unavailable');
  assert.equal(rec.status, 'store-unavailable');
  assert.equal(rec.error, FAILURE_TEXT['store-unavailable']);
  assert.ok(!/\/|EISDIR|encrypt/.test(rec.error), 'no path or raw error');
  assert.equal(rec.entries(['2026-10-18']).entries.length, 1, 'a held entry still reads back');
  available = true;
  await step();
  rec.pause();
  assert.equal(written().length, 2);
  assert.equal(rec.pending.length, 0);
  rec.resume();
  assert.equal(rec.status, 'recording');
});

test('entries held for a store that keeps refusing are capped, oldest dropped', async () => {
  const { rec } = setup({ safe: fakeSafe(false) });
  rec.pending = Array.from({ length: MAX_PENDING }, (_, i) => ({
    bundleId: 'com.apple.Notes',
    app: 'Notes',
    title: `${i}`,
    start: T0,
    end: T0 + 1,
  }));
  await rec.tick();
  rec.pause();
  assert.equal(rec.pending.length, MAX_PENDING);
  assert.equal(rec.pending[0].title, '1');
});

test('W1: allow-list edits all land, refusals change nothing, retention is checked', () => {
  const { rec, store } = setup();
  assert.deepEqual(rec.allowApp({ bundleId: 'com.apple.TextEdit', name: 'TextEdit' }), { ok: true });
  assert.equal(rec.allowApp({ bundleId: 'com.1password.1password' }).ok, false);
  assert.deepEqual(rec.allowSite('www.example.com'), { ok: true, site: 'example.com' });
  assert.equal(rec.allowSite('chase.com').ok, false);
  assert.deepEqual(
    store.readSettings().apps.map((a: { bundleId: string }) => a.bundleId),
    ['com.apple.Notes', 'com.apple.TextEdit'],
  );
  rec.removeSite('example.com');
  rec.removeApp('com.apple.TextEdit');
  assert.deepEqual(store.readSettings().sites, []);
  assert.equal(rec.setRetention(14).ok, true);
  assert.equal(store.readSettings().retentionDays, 14);
  assert.equal(rec.setRetention(365).ok, false);
  rec.markExplainerSeen();
  assert.equal(store.readSettings().explainerSeen, true);
});

test('Delete day and Delete all leave nothing of those days on disk or in memory', async () => {
  const { rec, step, store, advance } = setup();
  await step();
  rec.pause();
  rec.resume();
  await step();
  assert.ok(rec.open);
  rec.pending = [{ bundleId: 'com.apple.Notes', app: 'Notes', title: 'held', start: T0, end: T0 + 1 }];
  rec.deleteDay('2026-10-18');
  assert.equal(rec.open, null);
  assert.deepEqual(rec.pending, []);
  assert.deepEqual(rec.entries(['2026-10-18']).entries, []);
  await step();
  advance(24 * 3600 * 1000);
  rec.pending = [{ bundleId: 'com.apple.Notes', app: 'Notes', title: 'held', start: T0, end: T0 + 1 }];
  rec.deleteDay('2026-10-19');
  assert.equal(rec.pending.length, 1, 'another day stays');
  assert.ok(rec.open, 'another day stays');
  rec.deleteAll();
  assert.equal(rec.open, null);
  assert.deepEqual(rec.pending, []);
  assert.deepEqual(store.listDays(), []);
});

test('a day change prunes past the retention; a failed prune is retried later', async () => {
  const { rec, store, step, advance } = setup({ settings: { retentionDays: 7 } });
  store.append([{ bundleId: 'com.apple.Notes', app: 'Notes', title: 'old', start: T0 - 8 * 86400000, end: T0 - 8 * 86400000 + 1 }]);
  await step();
  assert.equal(store.listDays().length, 1, 'same day: no prune yet');
  advance(86400000);
  const prune = store.prune.bind(store);
  store.prune = () => {
    throw new Error('EPERM');
  };
  await step();
  store.prune = prune;
  advance(86400000);
  await step();
  rec.pause();
  assert.ok(!store.listDays().includes('2026-10-10'));
});

test('unreadable saved settings: off, with the reason in the state', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rec-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'settings.json'), 'not json');
  const rec = new Recorder({
    store: new HistoryStore({ dir: d, safeStorage: fakeSafe() }),
    sample: async () => notes(),
    idleSeconds: async () => 0,
  });
  assert.equal(rec.status, 'off');
  assert.match(rec.state.settingsError, /could not be read/);
  assert.equal(rec.running, false);
  rec.dispose();
});

test('W2: after a partial write only the entries that did not reach the disk are kept, so none is written twice', async () => {
  const { rec, store, written } = setup();
  const e18 = { bundleId: 'com.apple.Notes', app: 'Notes', title: '18th', start: T0, end: T0 + 1 };
  const e19 = { bundleId: 'com.apple.Notes', app: 'Notes', title: '19th', start: T0 + 86400000, end: T0 + 86400001 };
  fs.mkdirSync(path.join(store.days, `${'2026-10-19'}.jsonl`), { recursive: true });
  rec.open = e18;
  rec.pending = [e19];
  rec.pause();
  assert.deepEqual(rec.pending, [e19]);
  fs.rmSync(path.join(store.days, '2026-10-19.jsonl'), { recursive: true });
  rec.resume();
  rec.open = { ...e18, title: 'next' };
  rec.pause();
  assert.deepEqual(
    written()
      .map((e: { title: string }) => e.title)
      .sort(),
    ['18th', '19th', 'next'],
  );
});

test('W2: an unexpected store failure keeps every entry for the next write', () => {
  const { rec, store } = setup();
  const e = { bundleId: 'com.apple.Notes', app: 'Notes', title: 'x', start: T0, end: T0 + 1 };
  store.append = () => {
    throw new TypeError('boom');
  };
  rec.pending = [e];
  rec.open = { ...e, title: 'y' };
  rec.pause();
  assert.deepEqual(
    rec.pending.map((x: { title: string }) => x.title),
    ['x', 'y'],
  );
  assert.equal(rec.errorStatus, 'store-unavailable');
});

test('a failure that repeats on every tick goes to diagnostics once, when it starts, without its raw text in the state', async () => {
  clearIgnored();
  const { rec, step } = setup({ sample: async () => ({ error: 'unavailable', cause: new Error('helper not found at /Users/me/x.app') }) });
  for (let i = 0; i < 5; i++) await step();
  const noted = recentIgnored()
    .map((e: unknown) => JSON.stringify(e))
    .filter((l: string) => l.includes('Computer History'));
  assert.equal(noted.length, 1);
  assert.match(noted[0], /helper not found/);
  assert.equal(rec.error, FAILURE_TEXT.unavailable);
  rec.sampleNow = async () => notes();
  await step();
  rec.sampleNow = async () => ({ error: 'unavailable', cause: new Error('again') });
  await step();
  assert.equal(
    recentIgnored()
      .map((e: unknown) => JSON.stringify(e))
      .filter((l: string) => l.includes('Computer History')).length,
    2,
    'a new failure after a good sample is noted again',
  );
});

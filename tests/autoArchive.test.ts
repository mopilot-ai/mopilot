// Issue 1367: main archives chats inactive for the chosen days on every harness, never one something still holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutoArchive, DAY_MS, FIRST_SWEEP_MS, SWEEP_MS, SETTING_SWEEP_MS } = require('../electron/session/autoArchive.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { busy } = require('../electron/session/controllerEvents.cjs');
const { autoArchiveDays, AUTO_ARCHIVE_DAYS } = await import('../shared/autoArchive.mjs');

const NOW = 1_800_000_000_000;
const old = NOW - 10 * DAY_MS;
const recent = NOW - 2 * DAY_MS;

function setup(o: { days?: number | null; sources?: Record<string, () => Promise<any[]>>; scheduled?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-archive-'));
  const chats = new ChatsStore(path.join(dir, 'threads'), { now: () => NOW });
  const f: any = { days: o.days === undefined ? 7 : o.days, broadcasts: [], natives: [], children: {}, timers: [] };
  const state = new SessionStore({ ownGoal: (id: string) => f.ownGoals?.[id] });
  f.listed = { codex: [], claude: [], acp: [] };
  f.a = new AutoArchive({
    chats,
    state,
    busy,
    days: () => f.days,
    sources: o.sources ?? {
      codex: async () => f.listed.codex,
      claude: async () => f.listed.claude,
      acp: async () => f.listed.acp,
    },
    scheduled: async () => o.scheduled ?? [],
    children: (id: string) => f.children[id] ?? [],
    archiveNative: (id: string) => (chats.get(id)?.kind === 'codex' ? (f.natives.push(id), f.nativeResult ?? Promise.resolve()) : null),
    broadcast: (id: string, view: any) => f.broadcasts.push([id, view?.meta?.archived]),
    now: () => NOW,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      f.timers.push(t);
      return t;
    },
    clearTimer: (t: any) => t && (t.cleared = true),
  });
  return { ...f, f, chats, state };
}
const archived = (chats: any, id: string) => chats.get(id)?.meta.archived ?? null;

test('the setting offers Never and its day choices; anything else is Never', () => {
  assert.deepEqual(AUTO_ARCHIVE_DAYS, [3, 7, 14, 30, 90]);
  for (const d of AUTO_ARCHIVE_DAYS) assert.equal(autoArchiveDays({ autoArchiveDays: d }), d);
  for (const v of [null, undefined, 0, 5, -7, '7', Number.NaN, {}]) assert.equal(autoArchiveDays({ autoArchiveDays: v }), null);
  assert.equal(autoArchiveDays(null), null);
  assert.equal(autoArchiveDays(undefined), null);
});

test('inactive chats on every harness are archived and shown to every window; recent ones stay', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [
    { key: 'cx-old', at: old },
    { key: 'cx-new', at: recent },
  ];
  f.listed.claude = [{ key: 'claude:old', at: old }];
  f.listed.acp = [{ key: 'acp:opencode:old', at: old }];
  const done = await a.sweep();
  assert.deepEqual(done.sort(), ['acp:opencode:old', 'claude:old', 'cx-old']);
  for (const id of done) assert.equal(archived(chats, id), NOW);
  assert.equal(archived(chats, 'cx-new'), null);
  assert.deepEqual(f.broadcasts.map(([id, at]: any) => [id, at]).sort(), done.map((id: string) => [id, NOW]).sort());
  // Codex's own archive is kept in step only for a chat whose own id is a Codex thread
  assert.deepEqual(f.natives, ['cx-old']);
});

test('Never archives nothing and lists nothing', async () => {
  let listed = 0;
  const { chats, a } = setup({ days: null, sources: { codex: async () => (listed++, [{ key: 'cx', at: old }]) } });
  assert.deepEqual(await a.sweep(), []);
  assert.equal(listed, 0);
  assert.equal(archived(chats, 'cx'), null);
});

test('pinned, held-goal, scheduled, MoMo’s, deleted, newer, unreadable and already archived chats are kept', async () => {
  const { f, chats, a } = setup({ scheduled: ['scheduled'] });
  const ids = ['pinned', 'goal-held', 'scheduled', 'momo', 'deleted', 'newer', 'unreadable', 'archived-before'];
  f.listed.codex = ids.map((key) => ({ key, at: old }));
  chats.patchMeta('pinned', { pinned: true });
  // MoMo's main chat is long-lived (electron/momo/mainChat.cjs)
  chats.patchMeta('momo', { momo: 'main' });
  chats.patchMeta('goal-held', { goalHeld: { objective: 'x' } });
  chats.patchMeta('archived-before', { archived: 123 });
  chats.isDeleted = (id: string) => id === 'deleted';
  chats.newer.add('newer');
  chats.unreadable.add('unreadable');
  assert.deepEqual(await a.sweep(), []);
  assert.equal(archived(chats, 'archived-before'), 123);
  assert.deepEqual(f.natives, []);
});

test('a chat working, queued, awaiting approval, switching or pursuing a goal is kept, and so is one with a working session', async () => {
  const { f, chats, state, a } = setup();
  const holds: Record<string, any> = {
    running: { turn: 'running' },
    awaiting: { turn: 'awaitingUser' },
    queued: { queue: [{ id: 'q' }] },
    approval: { approvals: [{ id: 1, method: 'x', params: {} }] },
    switching: { pendingSwitch: { harness: 'claude', model: null } },
    goal: { goal: { objective: 'ship', status: 'active' } },
    parent: {},
    'goal-done': { goal: { objective: 'ship', status: 'complete' } },
    idle: { turn: 'idle' },
  };
  for (const [id, patch] of Object.entries(holds)) state.patch(id, patch);
  state.patch('child', { turn: 'running' });
  f.children.parent = ['child'];
  f.listed.codex = Object.keys(holds).map((key) => ({ key, at: old }));
  assert.deepEqual((await a.sweep()).sort(), ['goal-done', 'idle']);
  assert.equal(archived(chats, 'parent'), null);
});

test("a Codex chat's goal is read from the adapter's own record, so no window's report (or none) lets it be archived mid-goal (#2759)", async () => {
  const { f, chats, state, a } = setup();
  f.ownGoals = { 'no-window': 'active', 'stale-report': 'active', paused: 'paused', 'done-here': 'complete' };
  // no window open: nothing wrote the session state, and no session is loaded for these chats
  state.patch('stale-report', { goal: { objective: 'ship', status: 'complete' } });
  // the window's report lags behind the adapter: it still says active for a goal the adapter saw complete
  state.patch('done-here', { goal: { objective: 'ship', status: 'active' } });
  f.listed.codex = ['no-window', 'stale-report', 'paused', 'done-here'].map((key) => ({ key, at: old }));
  assert.deepEqual((await a.sweep()).sort(), ['done-here']);
  for (const id of ['no-window', 'stale-report', 'paused']) assert.equal(archived(chats, id), null);
});

test('a chat that switched harness counts activity on every segment and is archived once, under its own id', async () => {
  const { f, chats, a } = setup();
  chats.ensure('cx');
  chats.setSegments('cx', [
    { harness: 'codex', nativeId: 'cx', start: 0, count: 1 },
    { harness: 'claude', nativeId: 'claude:later', start: 1, count: null },
  ]);
  f.listed.codex = [{ key: 'cx', at: old }];
  f.listed.claude = [{ key: 'claude:later', at: recent }];
  assert.deepEqual(await a.sweep(), []);
  f.listed.claude = [{ key: 'claude:later', at: old }];
  assert.deepEqual(await a.sweep(), ['cx']);
  assert.equal(chats.records.has('claude:later'), false, 'the switched session never becomes a chat of its own');
});

test('a chat whose activity is unknown is kept: a segment not listed, or a harness that failed to list', async () => {
  const { f, chats, a } = setup({
    sources: {
      codex: async () => [{ key: 'cx', at: old }],
      claude: async () => {
        throw new Error('signed out');
      },
      acp: async () => [{ key: 'acp:x:bad', at: Number.NaN }],
    },
  });
  chats.ensure('switched');
  chats.setSegments('switched', [
    { harness: 'codex', nativeId: 'switched', start: 0, count: 1 },
    { harness: 'claude', nativeId: 'claude:gone', start: 1, count: null },
  ]);
  f.listed = null;
  assert.deepEqual(await a.sweep(), ['cx']);
  assert.equal(archived(chats, 'switched'), null);
  assert.equal(archived(chats, 'acp:x:bad'), null);
});

test('a restored chat counts as used when restored, so the next sweep keeps it until it is inactive again', async () => {
  let now = NOW;
  const { f, chats, a } = setup();
  a.now = () => now;
  chats.now = () => now;
  f.listed.codex = [{ key: 'cx', at: old }];
  assert.deepEqual(await a.sweep(), ['cx']);
  now = NOW + DAY_MS;
  chats.patchMeta('cx', { archived: null });
  assert.equal(chats.get('cx').meta.activeAt, now);
  assert.deepEqual(await a.sweep(), []);
  now += 8 * DAY_MS;
  assert.deepEqual(await a.sweep(), ['cx']);
});

test('only a restore stamps activity: other meta changes and archiving do not', () => {
  const { chats } = setup();
  chats.patchMeta('cx', { pinned: true });
  chats.patchMeta('cx', { archived: 5 });
  chats.patchMeta('cx', { archived: 6 });
  assert.equal(chats.get('cx').meta.activeAt, null);
  chats.patchMeta('cx', { archived: null });
  assert.equal(chats.get('cx').meta.activeAt, NOW);
  chats.patchMeta('cx', { archived: null, pinned: false });
  assert.equal(chats.get('cx').meta.activeAt, NOW);
});

test('a send that lands during the sweep, or the setting turned off, wins before the next write', async () => {
  const { f, chats, state, a } = setup();
  f.listed.codex = [
    { key: 'first', at: old },
    { key: 'second', at: old },
    { key: 'third', at: old },
  ];
  let n = 0;
  a.o.broadcast = (id: string) => {
    n++;
    // archiving 'first' gives way; meanwhile the user sends in 'second'
    if (id === 'first') state.patch('second', { turn: 'running' });
  };
  assert.deepEqual(await a.sweep(), ['first', 'third']);
  assert.equal(n, 2);
  f.listed.codex = [
    { key: 'a', at: old },
    { key: 'b', at: old },
  ];
  a.o.broadcast = () => {
    f.days = null;
    a.settingsChanged();
  };
  assert.deepEqual(await a.sweep(), ['a']);
  assert.equal(archived(chats, 'b'), null);
});

test('a chat the store refuses to write is not reported or broadcast', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [{ key: 'cx', at: old }];
  chats.admitCommit = () => false;
  assert.deepEqual(await a.sweep(), []);
  assert.deepEqual(f.broadcasts, []);
});

test('a failed native archive leaves the chat archived in MoPilot', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [{ key: 'cx', at: old }];
  f.nativeResult = Promise.reject(new Error('Codex is down'));
  assert.deepEqual(await a.sweep(), ['cx']);
  await new Promise((r) => setImmediate(r));
  assert.equal(archived(chats, 'cx'), NOW);
});

test('one sweep at a time: asking during one runs it once more afterwards', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let lists = 0;
  const { chats, a } = setup({
    sources: {
      codex: async () => {
        lists++;
        if (lists === 1) await gate;
        return [{ key: `cx${lists}`, at: old }];
      },
    },
  });
  const first = a.sweep();
  const second = a.sweep();
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, ['cx1', 'cx2']);
  assert.equal(lists, 2);
  assert.equal(archived(chats, 'cx2'), NOW);
  // once settled, the next sweep is a fresh one
  assert.deepEqual(await a.sweep(), ['cx3']);
  assert.equal(lists, 3);
});

test('a scheduled-task listing that fails archives nothing this time', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [{ key: 'cx', at: old }];
  a.o.scheduled = async () => {
    throw new Error('tasks unreadable');
  };
  await assert.rejects(a.sweep(), /tasks unreadable/);
  assert.equal(archived(chats, 'cx'), null);
});

test('sweeps run after startup, every hour and soon after the number of days changes', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [{ key: 'cx', at: old }];
  a.start();
  assert.deepEqual(
    f.timers.map((t: any) => t.ms),
    [FIRST_SWEEP_MS],
  );
  f.timers[0].fn();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(archived(chats, 'cx'), NOW);
  assert.equal(f.timers.at(-1).ms, SWEEP_MS);
  // the same setting again (another pref changed) schedules nothing new
  a.settingsChanged();
  assert.equal(f.timers.length, 2);
  f.days = 3;
  a.settingsChanged();
  assert.equal(f.timers.at(-1).ms, SETTING_SWEEP_MS);
  assert.equal(f.timers[1].cleared, true);
  // Never: the pending sweep stays, and finds nothing to do
  f.days = null;
  a.settingsChanged();
  assert.equal(f.timers.length, 3);
  a.stop();
  assert.equal(f.timers[2].cleared, true);
  assert.equal(a.timer, null);
});

test('a sweep that fails is noted and the next one is still scheduled', async () => {
  const { a, f } = setup();
  a.o.scheduled = async () => {
    throw new Error('boom');
  };
  a.schedule(10);
  f.timers[0].fn();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(f.timers.at(-1).ms, SWEEP_MS);
});

test('the default timers are real and do not keep the app alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-archive-'));
  const a = new AutoArchive({
    chats: new ChatsStore(path.join(dir, 'threads')),
    state: new SessionStore(),
    busy,
    days: () => null,
    sources: {},
    scheduled: async () => [],
    children: () => [],
    archiveNative: () => null,
    broadcast: () => undefined,
  });
  a.start();
  assert.equal(a.timer.hasRef(), false);
  a.stop();
  assert.equal(typeof a.now(), 'number');
});

test('a native archive that throws at once does not stop the sweep', async () => {
  const { f, chats, a } = setup();
  f.listed.codex = [
    { key: 'one', at: old },
    { key: 'two', at: old },
  ];
  a.o.archiveNative = () => {
    throw new Error('unknown harness kind');
  };
  assert.deepEqual(await a.sweep(), ['one', 'two']);
  assert.equal(archived(chats, 'two'), NOW);
});

test('a chat used while the harnesses were being listed is kept, even if its turn already ended', async () => {
  let used = 0;
  const { chats, state, a } = setup({
    sources: {
      codex: async () => {
        if (!used++) {
          // the user sends in 'used' and its short turn ends before the sweep writes
          state.patch('used', { turn: 'running' });
          state.patch('used', { turn: 'idle' });
          // a chat whose session first appears now was used too
          state.patch('new-session', { turn: 'idle', unread: true });
        }
        return [
          { key: 'used', at: old },
          { key: 'new-session', at: old },
          { key: 'untouched', at: old },
        ];
      },
    },
  });
  state.patch('used', { turn: 'idle', unread: true });
  state.patch('untouched', { turn: 'idle', unread: true });
  assert.deepEqual(await a.sweep(), ['untouched']);
  assert.equal(archived(chats, 'used'), null);
  // the next sweep sees it unchanged since its listing, and goes by its listed time again
  assert.deepEqual((await a.sweep()).sort(), ['new-session', 'used']);
});

// MoMo's activity in main and on the phone (electron/app/momoActivity.cjs, remote/momoOps.cjs, remote/methods/momo.cjs, remote/service.cjs onMomoActivity): routine runs from the routine store and errands from MoMo's own chats' history, the list only while MoMo is allowed (paused or not), a change told as momo.changed {area:'activity', id} to every paired phone, and the card id a MoMo chat's banner names reaching its "needs you" notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { settle, rig } from './support/remote-kit.ts';
import { ok, fail, momoRig } from './support/remote-momo-kit.ts';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { openMomoActivity } = require('../electron/app/momoActivity.cjs');
const { parseParams } = require('../shared/remote/schema.mjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

const NOW = Date.now();
const nav = {
  type: 'mcpToolCall',
  id: 'n',
  server: 'mopilot_browser',
  tool: 'navigate',
  arguments: { url: 'https://shop.example/x' },
  status: 'completed',
};

/** Main's services as the activity reads them: chats, session state, history through the peer runtime, and the phones. */
function fakeLive() {
  const told: string[] = [];
  const reads: any[] = [];
  const states = new Map<string, any>([['main', { rev: 3, turn: 'idle' }]]);
  const live: any = {
    chats: {
      records: new Map<string, any>([
        ['main', { segments: [1], meta: { momo: 'main' }, updatedAt: NOW }],
        ['memory', { segments: [2], meta: { momo: 'memory' }, updatedAt: NOW }],
        ['coding', { segments: [3], meta: {}, updatedAt: NOW }],
        ['run1', { segments: [4], meta: { momo: 'routine' } }],
      ]),
    },
    controller: { state: { has: (id: string) => states.has(id), get: (id: string) => states.get(id) } },
    peerRuntime: {
      readHistory: async (chatId: string, o: any) => {
        reads.push([chatId, o.open]);
        if (chatId === 'run1') return undefined;
        return { turns: [{ id: 't1', startedAt: (NOW - 1000) / 1000, status: 'completed', items: [nav] }] };
      },
    },
    chromePanel: { service: { phones: new Map([['p1', {}]]), onMomoActivity: (id: string) => told.push(id) } },
  };
  const routineStore = {
    routineRunsSince: (since: number) => [{ chatId: 'run1', taskId: 'r1', startedAt: NOW - 500 }].filter((r) => r.startedAt >= since),
    get: (id: string) => (id === 'r1' ? { name: 'Daily brief' } : undefined),
  };
  return { live, told, reads, states, routineStore };
}

test('main’s activity: routine runs and errands of MoMo’s own chats only; the list only while MoMo is allowed', async () => {
  const f = fakeLive();
  let allowed = true;
  const timers: (() => void)[] = [];
  const a = openMomoActivity({
    live: f.live,
    routineStore: f.routineStore,
    allowed: () => allowed,
    schedule: (fn: () => void) => timers.push(fn),
  });
  const { items } = await a.list();
  assert.deepEqual(
    items.map((i: any) => [i.id, i.kind, i.title, i.state, i.steps.map((s: any) => s.text)]),
    [
      ['routine:run1', 'routine', 'Daily brief', 'running', []],
      [`errand:main:t${NOW - 1000}`, 'errand', 'Errand', 'done', ['Opened shop.example']],
    ],
  );
  // the data-only and the coding chats are never read
  assert.deepEqual(f.reads.map((r: any) => r[0]).sort(), ['main', 'run1']);
  allowed = false;
  await assert.rejects(() => a.list(), /not available|isn't available|not allowed/i);
  // a MoMo chat's patch is compared only while allowed, and only for MoMo's chats
  a.onSessionPatch({ chatId: 'main' });
  assert.equal(timers.length, 0);
  allowed = true;
  a.onSessionPatch({ chatId: 'coding' });
  a.onSessionPatch({ chatId: 'nope' });
  a.onSessionPatch(null);
  assert.equal(timers.length, 0);
  // no phone connected: nothing to tell, nothing read
  f.live.chromePanel.service.phones = new Map();
  a.onSessionPatch({ chatId: 'main' });
  assert.equal(timers.length, 0);
  f.live.chromePanel.service.phones = new Map([['p1', {}]]);
  a.onSessionPatch({ chatId: 'main' });
  a.touched('run1');
  assert.equal(timers.length, 2);
  // a new errand turn in the main chat is told to phones by its id
  f.states.set('main', { rev: 4, turn: 'idle' });
  f.live.peerRuntime.readHistory = async () => ({
    turns: [
      { id: 't1', startedAt: (NOW - 1000) / 1000, status: 'completed', items: [nav] },
      { id: 't2', startedAt: NOW / 1000, status: 'completed', items: [nav] },
    ],
  });
  for (const fn of timers.splice(0)) fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.told, [`errand:main:t${NOW}`]);
});

test('main’s activity with nothing to read: no chats store, no controller, no phones', async () => {
  const f = fakeLive();
  const bare: any = { controller: {}, peerRuntime: f.live.peerRuntime };
  const a = openMomoActivity({ live: bare, routineStore: f.routineStore, allowed: () => true, schedule: (fn: () => void) => fn() });
  assert.deepEqual(
    (await a.list()).items.map((i: any) => [i.id, i.steps.length]),
    [['routine:run1', 0]],
  );
  const none = openMomoActivity({
    live: {},
    routineStore: { routineRunsSince: () => [{ chatId: 'x', taskId: 'gone', startedAt: NOW }], get: () => ({}) },
    allowed: () => true,
  });
  assert.equal((await none.list()).items[0].title, 'Routine');
  // a change with no phones service is dropped quietly
  none.touched('x');
});

test('a phone lists MoMo’s activity and hears each change; an account MoMo is off for gets neither', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  // before MoMo's background services are made
  fail(await p.ask('momo.activity.list'), 'failed', /MoMo is not ready/);
  const items = [{ id: 'routine:r', kind: 'routine', title: 'Daily brief', state: 'done', chatId: 'r', startedAt: 1, steps: [] }];
  (m.live as any).momoActivity = { list: async () => ({ items }) };
  assert.deepEqual(ok(await p.ask('momo.activity.list', { chatId: 'other' })), { items });
  assert.ok(ok(await p.ask('machine.hello')).capabilities.methods.includes('momo.activity.list'));
  m.r.service.onMomoActivity('routine:r');
  await settle();
  assert.deepEqual(
    p.events('momo.changed').map((e: any) => [e.area, e.itemId]),
    [['activity', 'routine:r']],
  );
  assert.deepEqual(parseParams('momo.activity.list', { chatId: 'x' }), {});
  const off = rig({ momo: false });
  const q = off.phone('p1');
  off.service.onMomoActivity('routine:r');
  await settle();
  assert.deepEqual(q.events(), []);
  fail(await q.ask('momo.activity.list'), 'invalid', /Unknown request: momo\.activity\.list/);
});

test('MoMo’s background work makes the activity, and a MoMo chat’s approval banner names its card while it is up', async () => {
  const w = world({ allowed: true });
  assert.equal(w.live.momoActivity, w.m.activity);
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 'mc', start: 0, count: null }], meta: { momo: 'main' } });
  const q = w.live.notifier.quiet;
  // the world's session state holds no card: the notice names none
  q('approval', 'mc', { cardId: 'a1' });
  assert.equal('cardId' in w.live.notifier.shown.at(-1)[2], false);
  w.live.controller.state = { get: () => ({ turn: 'awaitingUser', approvals: [{ id: 'a1' }] }) };
  q('approval', 'mc', { cardId: 'a1' });
  assert.equal(w.live.notifier.shown.at(-1)[2].cardId, 'a1');
  q('approval', 'mc');
  assert.equal('cardId' in w.live.notifier.shown.at(-1)[2], false);
  await w.m.close();
  // with no controller at all, a named card is never said to be up
  const v = world({ allowed: true, controller: false });
  v.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 'mc', start: 0, count: null }], meta: { momo: 'main' } });
  v.live.notifier.quiet('approval', 'mc', { cardId: 'a1' });
  assert.equal('cardId' in v.live.notifier.shown.at(-1)[2], false);
  await v.m.close();
  setMomoContextProvider(null);
});

test('a session change reaches MoMo’s activity through the session store’s publish', async () => {
  const w = world({ allowed: true });
  const seen: string[] = [];
  w.m.activity.onSessionPatch = (p: any) => void seen.push(p.chatId);
  w.live.sessions.publish({ chatId: 'mc', rev: 2, patch: { turn: 'running' } });
  assert.deepEqual(seen, ['mc']);
  await w.m.close();
  setMomoContextProvider(null);
});

test('the routine store lists a routine’s runs since a time, never another kind’s or a discarded one', async () => {
  const { RoutineStore } = require('../electron/momo/routineStore.cjs');
  const { fakeSafe, scratch } = await import('./support/momo-fixtures.ts');
  const s = new RoutineStore({ dir: scratch(), safeStorage: fakeSafe(), now: () => 1000 });
  await s.beginRun({ chatId: 'a', taskId: 'momo.r1', kind: 'momo-routine', due: 1 });
  await s.beginRun({ chatId: 'b', taskId: 'momo.feed', kind: 'momo-feed', due: 1 });
  await s.beginRun({ chatId: 'c', taskId: 'momo.r1', kind: 'momo-routine', due: 1 });
  await s.markDiscarded('c');
  assert.deepEqual(
    s.routineRunsSince(1000).map((r: any) => r.chatId),
    ['a'],
  );
  assert.deepEqual(s.routineRunsSince(1001), []);
});

test('a window showing MoMo’s activity (its right panel) hears each change; a phone is not needed, and a window that stopped hears nothing', async () => {
  const f = fakeLive();
  f.live.chromePanel.service.phones = new Map();
  let allowed = true;
  const timers: (() => void)[] = [];
  const sent: any[] = [];
  const a = openMomoActivity({
    live: f.live,
    routineStore: f.routineStore,
    allowed: () => allowed,
    schedule: (fn: () => void) => timers.push(fn),
    broadcastAll: (channel: string, payload: unknown) => sent.push([channel, payload]),
  });
  const newErrand = () => {
    f.states.set('main', { rev: (f.states.get('main').rev as number) + 1, turn: 'idle' });
    f.live.peerRuntime.readHistory = async () => ({
      turns: [{ id: `t${Date.now()}`, startedAt: Date.now() / 1000, status: 'completed', items: [nav] }],
    });
  };
  const run = async () => {
    for (const fn of timers.splice(0)) fn();
    await new Promise((r) => setTimeout(r, 10));
  };
  // no phone and no window: nothing is compared
  a.onSessionPatch({ chatId: 'main' });
  assert.equal(timers.length, 0);
  // a window shows the activity: the patch is compared (what it finds first is told too), and each later change is told to it
  a.watch(7, true);
  a.onSessionPatch({ chatId: 'main' });
  assert.equal(timers.length, 1);
  await run();
  assert.ok(sent.every(([channel]) => channel === 'momoChat:activityChanged'));
  const told = async () => {
    const before = sent.length;
    newErrand();
    a.touched('main');
    await run();
    return sent.slice(before);
  };
  const first = await told();
  assert.ok(first.length > 0);
  assert.match(first.at(-1)![1].id, /^errand:main:t/);
  // the window stops (or another one still shows it): told only while any shows
  a.watch(9, true);
  a.watch(7, false);
  assert.ok((await told()).length > 0);
  a.watch(9, false);
  assert.equal((await told()).length, 0);
  // not told while MoMo is not allowed, and no broadcast to make is no failure
  a.watch(9, true);
  allowed = false;
  assert.equal((await told()).length, 0);
  allowed = true;
  const quiet = openMomoActivity({ live: f.live, routineStore: f.routineStore, allowed: () => true, schedule: (fn: () => void) => fn() });
  quiet.watch(1, true);
  newErrand();
  quiet.touched('main');
  await new Promise((r) => setTimeout(r, 10));
});

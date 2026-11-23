// Codex turn notifications keep completion, unread state and delayed usage-limit notices owned by the current turn.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const item = (e: any) => listeners['codex.onItem'](e);
const note = (method: string, params: any) => item({ kind: 'notification', chatId: params.threadId ?? null, method, params });
const turns = (id: string) => st().runtime[id]?.turns ?? [];

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('turn started and completed: pending turns get their id, unread when off screen, limits suggest the other harness', async () => {
  item({ kind: 'turnStarting', chatId: 't', clientId: 'k', text: 'x', attachments: [], opts: {} });
  note('turn/started', { threadId: 't', turn: { id: 'T1', status: 'inProgress' } });
  assert.deepEqual(
    turns('t').map((x) => x.id),
    ['T1'],
  );
  note('turn/started', { threadId: 't', turn: { id: 'T1', status: 'inProgress' } });
  note('turn/started', { threadId: 't', turn: { id: 'T2', status: 'inProgress', startedAt: 1, items: [{ id: 'skip' }] } });
  assert.deepEqual(
    turns('t').map((x) => [x.id, x.items.length]),
    [
      ['T1', 1],
      ['T2', 0],
    ],
  );
  assert.equal(st().runtime.t.activeTurnId, 'T2');
  // completed: full items merge, the end is recorded, and the chat is unread off screen
  note('turn/completed', {
    threadId: 't',
    turn: { id: 'T2', status: 'completed', error: null, itemsView: 'full', items: [{ id: 'm1', type: 'agentMessage' }] },
  });
  let t2 = turns('t')[1];
  assert.deepEqual(
    [t2.status, t2.items.map((i) => i.id), typeof t2.completedAt, typeof t2.durationMs],
    ['completed', ['m1'], 'number', 'number'],
  );
  assert.equal(st().runtime.t.activeTurnId, null);
  assert.equal(st().unread.t, true);
  S.patchTurn('t', 'T3', () => ({ startedAt: null, items: [{ id: 'keep' } as any] }));
  S.patchRuntime('t', () => ({ activeTurnId: 'T1' }));
  note('turn/completed', {
    threadId: 't',
    turn: { id: 'T3', status: 'interrupted', completedAt: 5, durationMs: 9, items: [{ id: 'x' }], itemsView: 'summary' },
  });
  const t3 = turns('t')[2];
  assert.deepEqual([t3.completedAt, t3.durationMs, t3.items.map((i) => i.id)], [5, 9, ['keep']]);
  assert.equal(st().runtime.t.activeTurnId, 'T1');
  S.patchTurn('t', 'T4', () => ({ startedAt: null, items: [{ id: 'a' } as any, { id: 'local' } as any] }));
  note('turn/completed', {
    threadId: 't',
    turn: { id: 'T4', status: 'completed', itemsView: 'full', items: [{ id: 'a', v: 2 }, { id: 'b' }] },
  });
  assert.deepEqual(turns('t')[3].items, [{ id: 'a', v: 2 }, { id: 'local' }, { id: 'b' }]);
  assert.equal(turns('t')[3].durationMs, null);
  // the chat on screen (route, or chat tab) isn't marked unread; telemetry when sharing is on
  set({
    unread: {},
    route: { name: 'thread', id: 'v' } as any,
    prefs: { ...st().prefs, shareUsageData: true },
    runtime: { ...st().runtime, v: { turns: [{ id: 'V' }], settings: { model: 'm' }, tokenUsage: { last: { n: 1 } } } as any },
  });
  note('turn/completed', { threadId: 'v', turn: { id: 'V', status: 'completed', items: [] } });
  note('turn/completed', { threadId: 'v', turn: { id: 'gone', items: [] } });
  set({
    route: { name: 'home' },
    paneTabs: [{ id: 'c', kind: 'chat', threadId: 'w' }],
    paneActive: 'c',
    diffPanel: { open: true },
    runtime: { ...st().runtime, w: { turns: [{ id: 'W', status: 'inProgress' }] } as any },
  });
  note('turn/completed', { threadId: 'w', turn: { id: 'W', items: [] } });
  set({ paneTabs: [{ id: 'f', kind: 'files' }], paneActive: 'f' });
  note('turn/completed', { threadId: 'w2', turn: { id: 'W', items: [] } });
  assert.deepEqual(st().unread, { w2: true });
  assert.deepEqual(
    callsOf('telemetry.shareTurn').map((a) => [a[0], a[1], a[2], a[3].status]),
    [
      ['t', 'codex', null, 'completed'],
      ['t', 'codex', null, 'interrupted'],
      ['t', 'codex', null, 'completed'],
      ['v', 'codex', 'm', 'completed'],
      ['w', 'codex', null, undefined],
    ],
  );
  // a usage limit: the other harness is suggested unless the chat picked up again (going on by itself: tests/limitContinueMain.test.ts)
  set({
    prefs: { ...st().prefs, autoContinueOnLimit: false },
    claude: { status: { state: 'ready' } as any, models: [{ id: 'o', label: 'Opus', isDefault: true }] as any },
    toasts: [],
  });
  for (const id of ['u', 'u2']) S.patchRuntime(id, () => ({ turns: [S.newTurn('U')] }));
  note('turn/completed', {
    threadId: 'u',
    turn: { id: 'U', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [] },
  });
  note('turn/completed', {
    threadId: 'u2',
    turn: { id: 'U', status: 'failed', error: { codexErrorInfo: 'rateLimitExceeded' }, items: [] },
  });
  S.patchRuntime('u2', () => ({ activeTurnId: 'again' }));
  mock.timers.tick(2500);
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['Codex limit reached. You can switch to Claude Code and continue in this chat.'],
  );
});

test("a MoMo chat's finished turn is only counted as usage data, never shared; a coding chat's is shared", () => {
  set({
    prefs: { ...st().prefs, shareUsageData: true },
    momoChats: { mm: 'main', mf: 'main', mg: 'main' },
    runtime: { ...st().runtime, mm: { turns: [{ id: 'M' }] }, mf: { turns: [{ id: 'F' }] }, cc: { turns: [{ id: 'C' }] } } as any,
  });
  note('turn/completed', { threadId: 'mm', turn: { id: 'M', status: 'completed', items: [] } });
  // a failed turn, and a turn the store never held
  note('turn/completed', { threadId: 'mf', turn: { id: 'F', status: 'failed', items: [] } });
  note('turn/completed', { threadId: 'mg', turn: { id: 'G', items: [] } });
  note('turn/completed', { threadId: 'cc', turn: { id: 'C', status: 'completed', items: [] } });
  assert.deepEqual(
    callsOf('telemetry.shareTurn').map((a) => a[0]),
    ['cc'],
  );
  assert.deepEqual(callsOf('telemetry.countTurn'), [
    ['mm', 'completed'],
    ['mf', 'failed'],
    ['mg', undefined],
  ]);
  // sharing off: not even counted
  set({ prefs: { ...st().prefs, shareUsageData: false } });
  note('turn/completed', { threadId: 'mm', turn: { id: 'M', status: 'completed', items: [] } });
  assert.equal(callsOf('telemetry.countTurn').length, 3);
});

test('a completed replacement turn retires the old limit suggestion even when the chat is idle again', () => {
  set({ claude: { status: { state: 'ready' } as any, models: [{ id: 'o', label: 'Opus', isDefault: true }] as any }, toasts: [] });
  S.patchRuntime('limit-replaced', () => ({ turns: [S.newTurn('limited')] }));
  note('turn/completed', {
    threadId: 'limit-replaced',
    turn: { id: 'limited', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [] },
  });
  S.patchRuntime('limit-replaced', (r) => ({ turns: [...r.turns, S.newTurn('continued')], activeTurnId: null }));
  note('turn/completed', {
    threadId: 'limit-removed',
    turn: { id: 'removed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [] },
  });
  set((s) => ({ runtime: Object.fromEntries(Object.entries(s.runtime).filter(([id]) => id !== 'limit-removed')) }));
  note('turn/completed', {
    threadId: 'limit-empty',
    turn: { id: 'empty', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [] },
  });
  mock.timers.tick(2500);
  assert.deepEqual(st().toasts, []);
});

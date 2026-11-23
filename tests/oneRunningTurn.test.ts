// A chat runs one turn at a time (#2332): every turn start settles a turn left running, and only the chat's running turn draws live.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, flush, listeners, bootImpls, impl } from './support/store-harness.ts';
import { addPendingTurn, earlyTurnId, settleOtherTurns } from '../src/store/pendingTurns.ts';
import { liveTurnId } from '../src/lib/liveTurn.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, sessions, resetState } = await loadStore();
const { showEarlyTurn } = await import('../src/store/earlyTurn.ts');
const st = () => S.useStore.getState();
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
const t = (id: string, status: string, extra: object = {}) =>
  ({ id, status, items: [], startedAt: 1, completedAt: null, durationMs: null, error: null, ...extra }) as any;
const statuses = (turns: any[]) => turns.map((x) => `${x.id}:${x.status}`);

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

test('settling keeps the started turn and every finished one; nothing to settle leaves the list as it was', () => {
  const done = [t('a', 'completed', { completedAt: 5 }), t('b', 'interrupted')];
  assert.equal(settleOtherTurns(done, 'b'), done);
  const settled = settleOtherTurns([t('a', 'inProgress'), t('b', 'failed'), t('c', 'inProgress')], 'c');
  assert.deepEqual(statuses(settled), ['a:interrupted', 'b:failed', 'c:inProgress']);
  assert.ok((settled[0].completedAt ?? 0) > 1, 'the stale turn gets an end time, so it reads as ended, not still running elsewhere');
});

test("a harness's pending turn settles a turn left running and still replaces its own early copy", () => {
  const turns = addPendingTurn([t('old', 'inProgress'), t(earlyTurnId('q'), 'inProgress')], t('pending-c', 'inProgress'), 'q');
  assert.deepEqual(statuses(turns), ['old:interrupted', 'pending-c:inProgress']);
});

test('turn/started settles any other running turn: a new turn, a renamed pending one, and a repeated start', () => {
  S.useStore.setState({ runtime: { g: { ...st().runtime.g, turns: [t('stale', 'inProgress')] } } as any });
  note('turn/started', { threadId: 'g', turn: { id: 'G1', status: 'inProgress' } });
  assert.deepEqual(statuses(st().runtime.g.turns), ['stale:interrupted', 'G1:inProgress']);
  assert.equal(st().runtime.g.activeTurnId, 'G1');

  // a pending send is named by its turn; a turn left running ahead of it settles
  S.useStore.setState({ runtime: { g: { ...st().runtime.g, turns: [t('stale', 'inProgress'), t('pending-x', 'inProgress')] } } as any });
  note('turn/started', { threadId: 'g', turn: { id: 'G2', status: 'inProgress' } });
  assert.deepEqual(statuses(st().runtime.g.turns), ['stale:interrupted', 'G2:inProgress']);

  // the same turn started again (a resumed stream) keeps itself running and settles the rest
  S.useStore.setState({ runtime: { g: { ...st().runtime.g, turns: [t('stale', 'inProgress'), t('G3', 'inProgress')] } } as any });
  note('turn/started', { threadId: 'g', turn: { id: 'G3', status: 'inProgress' } });
  assert.deepEqual(statuses(st().runtime.g.turns), ['stale:interrupted', 'G3:inProgress']);

  // its own end, arriving late, still sets how the settled turn ended
  note('turn/completed', { threadId: 'g', turn: { id: 'stale', status: 'completed', items: [] } });
  assert.equal(st().runtime.g.turns[0].status, 'completed');
});

test("a send's early turn settles a turn left running", () => {
  S.useStore.setState({ runtime: { e: { ...st().runtime.e, turns: [t('stale', 'inProgress')] } } as any });
  showEarlyTurn('e', 'r1', []);
  assert.deepEqual(statuses(st().runtime.e.turns), ['stale:interrupted', `${earlyTurnId('r1')}:inProgress`]);
});

test("the chat's running turn is its active turn while that runs, else the latest still running", () => {
  const turns = [t('a', 'inProgress'), t('b', 'completed'), t('c', 'inProgress')];
  assert.equal(liveTurnId(turns, 'a'), 'a');
  // an active turn that ended (or none, or one not in the list): another app's running turn, followed on disk, still draws live
  assert.equal(liveTurnId(turns, 'b'), 'c');
  assert.equal(liveTurnId(turns, null), 'c');
  assert.equal(liveTurnId(turns, 'gone'), 'c');
  assert.equal(liveTurnId([t('b', 'completed')], undefined), null);
});

test('a Codex chat this window runs opens on its latest running turn, not an older one read back unfinished', async () => {
  const served = (id: string) => ({ id, status: 'inProgress', items: [], startedAt: 1, completedAt: null, durationMs: null, error: null });
  impl['api.threadRead'] = async () => ({ thread: { id: 'm3' } });
  // newest first, as the app-server pages them
  impl['api.threadTurns'] = async () => ({ data: [served('now'), served('stale')], nextCursor: null });
  impl['session.snapshot'] = async (id: string) => ({ ...sessions.sessionOf(id), rev: 1, turn: 'running' });
  await S.openThread('m3');
  assert.equal(st().runtime.m3.activeTurnId, 'now');
});

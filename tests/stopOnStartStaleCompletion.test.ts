// Esc right after Enter on Codex (#1658, #3896): the previous stopped turn's late turn/completed must not drop the Stop queued for the unnamed new turn.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const { onCodexItem } = await import('../src/store/send.ts');
const { stopOnStart, stopSeenTurns } = await import('../src/store/stop.ts');

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  stopOnStart.clear();
  stopSeenTurns.clear();
});

const note = (method: string, turnId: string) =>
  ({ kind: 'notification', method, params: { threadId: 'cx', turn: { id: turnId, status: 'completed', items: [] } } }) as any;

test('a stale turn/completed leaves the queued Stop for the new turn; its turn/started sends it', async () => {
  S.useStore.setState({ runtime: { cx: { activeTurnId: 'pending-k2', turns: [{ id: 'old' }, { id: 'pending-k2' }] } as any } });
  assert.equal(await S.interrupt('cx'), true);
  assert.equal(stopOnStart.get('cx'), 'cx');
  // the previous (stopped) turn finishes after the new message was sent
  onCodexItem(note('turn/completed', 'old'));
  assert.equal(stopOnStart.get('cx'), 'cx');
  assert.deepEqual(callsOf('sem.pauseCodexGoal'), []);
  S.useStore.setState({ runtime: { cx: { activeTurnId: 'new', turns: [] } as any } });
  onCodexItem(note('turn/started', 'new'));
  await flush();
  assert.equal(stopOnStart.has('cx'), false);
  assert.equal(callsOf('sem.pauseCodexGoal').length, 1);
});

test('a turn/completed of a turn this window never saw, or once the turn is named, takes the Stop with it', async () => {
  // unnamed turn, completion of an unknown turn (it ended unseen)
  S.useStore.setState({ runtime: { cx: { activeTurnId: 'pending-k2', turns: [{ id: 'pending-k2' }] } as any } });
  await S.interrupt('cx');
  onCodexItem(note('turn/completed', 'x'));
  assert.equal(stopOnStart.has('cx'), false);
  // the turn is no longer unnamed
  stopOnStart.set('cx', 'cx');
  S.useStore.setState({ runtime: { cx: { activeTurnId: null, turns: [{ id: 'x' }] } as any } });
  onCodexItem(note('turn/completed', 'x'));
  assert.equal(stopOnStart.has('cx'), false);
  assert.deepEqual(callsOf('sem.pauseCodexGoal'), []);
});

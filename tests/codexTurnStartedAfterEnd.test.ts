// The app's own Codex path (window store, src/store/send.ts and notifications.ts): the adapter's `turnStarted` names the turn only once `turn/start` has answered, and an app-server that reports a short turn over first (J8's stand-in does) must still leave the chat idle: a start named after the turn's end opens nothing.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();

beforeEach(() => {
  resetState();
  resetAll();
});

const sending = (chatId: string, clientId: string) =>
  S.onCodexItem({
    kind: 'turnStarting',
    chatId,
    clientId,
    itemId: `i-${clientId}`,
    text: 'hi',
    attachments: [],
    opts: {},
    origin: null,
  } as any);
const named = (chatId: string, clientId: string, turnId: string) =>
  S.onCodexItem({ kind: 'turnStarted', chatId, clientId, turnId, text: 'hi', human: true, model: null, effort: null } as any);
const turn = (id: string, status: string) => ({ id, status, items: [], error: null });

test('the usual order: the start is named while the turn runs, and the turn is the chat’s active one until it completes', () => {
  sending('c', 'k1');
  assert.equal(st().runtime.c.activeTurnId, 'pending-k1');
  S.applyNotification('turn/started', { threadId: 'c', turn: turn('t1', 'inProgress') } as any);
  named('c', 'k1', 't1');
  assert.equal(st().runtime.c.activeTurnId, 't1');
  S.applyNotification('turn/completed', { threadId: 'c', turn: turn('t1', 'completed') } as any);
  assert.equal(st().runtime.c.activeTurnId, null);
});

test('J8: the turn is over before turn/start answers, and the answer does not make the finished turn the chat’s active one', () => {
  sending('c', 'k1');
  S.applyNotification('turn/started', { threadId: 'c', turn: turn('t1', 'inProgress') } as any);
  S.applyNotification('turn/completed', { threadId: 'c', turn: turn('t1', 'completed') } as any);
  // the chat is waiting on a start that will never be told: the optimistic id is still its active turn
  named('c', 'k1', 't1');
  assert.equal(st().runtime.c.activeTurnId, null, 'a turn that completed is not the active one');
  assert.equal(st().runtime.c.turns.find((t: any) => t.id === 't1')?.status, 'completed');
  assert.equal(
    st().runtime.c.turns.some((t: any) => t.id === 'pending-k1'),
    false,
    'the optimistic turn became the real one',
  );
});

test('a start for a turn that is still running keeps it active, and a start for another chat’s turn changes nothing', () => {
  sending('c', 'k1');
  sending('d', 'k2');
  S.applyNotification('turn/started', { threadId: 'c', turn: turn('t1', 'inProgress') } as any);
  named('c', 'k1', 't1');
  assert.equal(st().runtime.c.activeTurnId, 't1');
  assert.equal(st().runtime.d.activeTurnId, 'pending-k2');
});

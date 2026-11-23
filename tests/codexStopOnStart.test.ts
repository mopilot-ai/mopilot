// src/store/send.ts: a Codex Stop pressed while the turn starts runs once the app-server says turn/started (#1658).
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const item = (e: any) => listeners['codex.onItem'](e);
const note = (method: string, params: any) => item({ kind: 'notification', chatId: params.threadId ?? null, method, params });

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

test('Esc right after Enter on Codex: a Stop while the turn starts runs once the app-server says turn/started (#1658)', async () => {
  const started = (threadId: string, id: string) => note('turn/started', { threadId, turn: { id, status: 'inProgress', items: [] } });
  item({ kind: 'turnStarting', chatId: 'q', clientId: 'k1', text: 'long', attachments: [], opts: {} });
  await S.interrupt('q');
  // named by turn/start's answer, but not active in the app-server yet: nothing to interrupt
  item({ kind: 'turnStarted', chatId: 'q', clientId: 'k1', turnId: 'Q1', text: 'long' });
  await flush();
  assert.deepEqual(callsOf('sem.pauseCodexGoal'), []);
  started('q', 'Q1');
  await flush();
  assert.deepEqual(callsOf('sem.pauseCodexGoal'), [['q']]);
  // once only: the chat's next turn is not stopped, nor another chat's
  started('other', 'O1');
  item({ kind: 'turnStarting', chatId: 'q', clientId: 'k2', text: 'next', attachments: [], opts: {} });
  started('q', 'Q2');
  await flush();
  assert.equal(callsOf('sem.pauseCodexGoal').length, 1);
  // a turn that failed to start drops its Stop
  item({ kind: 'turnStarting', chatId: 'r', clientId: 'k3', text: 'x', attachments: [], opts: {} });
  await S.interrupt('r');
  item({ kind: 'turnFailed', chatId: 'r', clientId: 'k3', error: 'no quota' });
  started('r', 'R1');
  await flush();
  assert.equal(callsOf('sem.pauseCodexGoal').length, 1);
  // a turn that ended without this window seeing it start takes its Stop along: the next turn runs
  item({ kind: 'turnStarting', chatId: 'u', clientId: 'k5', text: 'x', attachments: [], opts: {} });
  await S.interrupt('u');
  note('item/completed', { threadId: 'u', turnId: 'U1', item: { type: 'agentMessage', id: 'm', text: '' } });
  note('turn/completed', { threadId: 'u', turn: { id: 'U1', status: 'completed', items: [] } });
  started('u', 'U2');
  await flush();
  assert.equal(callsOf('sem.pauseCodexGoal').length, 1);
  // a Stop that fails once the turn runs says so
  impl['sem.pauseCodexGoal'] = () => Promise.reject(new Error('gone'));
  item({ kind: 'turnStarting', chatId: 's', clientId: 'k4', text: 'x', attachments: [], opts: {} });
  await S.interrupt('s');
  started('s', 'S1');
  await flush();
  assert.ok(st().toasts.some((t) => t.text === "Couldn't stop: gone"));
});

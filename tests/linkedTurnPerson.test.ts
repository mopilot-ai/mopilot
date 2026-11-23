// What ChatController tells the linked-session orchestrator about a turn (electron/session/orchestration/reportRoute.cjs):
// whether a person started or joined the turn (its completion's `person`, Claude Desktop's turnInput.person), and when a
// running turn starts waiting on the user (onAwaitingUser), on any harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');

function setup(ctl: any = {}) {
  const rec = (id: string) => ({ id, segments: [{ kind: 'codex', nativeId: id }] });
  const state = new SessionStore();
  const step = async () => ({ started: true });
  const c = new ChatController({
    state,
    chats: { record: rec, records: new Map([['cx1', rec('cx1')]]) },
    codex: { startTurn: step, startGoal: step, steer: step, stopTurn: async () => true },
    claudeTurns: { startTurn: step, steer: step, stop: async () => {}, crashed: () => {} },
    acpTurns: { startTurn: step },
    claude: { send: async () => true },
    acp: { send: async () => true, cancel: () => true },
    ...ctl,
  });
  return { c, state };
}

test('a turn’s completion says whether a person started or joined it', () => {
  const finished: any[] = [];
  const { c, state } = setup({ onFinished: (e: any) => finished.push(e) });
  for (const activeTurn of [
    { id: 't-main', human: false },
    { id: 't-user', human: true },
    { id: 't-joined', human: false, userEngaged: true },
  ]) {
    state.patch('cx1', { turn: 'running', activeTurn });
    c.end('cx1');
  }
  // a turn that ended with no active turn known (a harness's own end) has no person in it
  c.end('cx1');
  assert.deepEqual(
    finished.map((e) => [e.turnId, e.person]),
    [
      ['t-main', false],
      ['t-user', true],
      ['t-joined', true],
      [null, false],
    ],
  );
});

test('onAwaitingUser fires when a running turn’s request arrives, not for a request on an idle chat', () => {
  const waiting: string[] = [];
  const { c, state } = setup();
  assert.equal(c.onAwaitingUser, null, 'no listener until the orchestrator hooks it');
  c.addApproval('cx1', { id: 'idle', method: 'item/commandExecution/requestApproval', params: {} });
  c.onAwaitingUser = (id: string) => waiting.push(id);
  c.addApproval('cx1', { id: 'idle-2', method: 'item/commandExecution/requestApproval', params: {} });
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  c.addApproval('cx1', { id: 'busy', method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(state.get('cx1').turn, 'awaitingUser');
  assert.deepEqual(waiting, ['cx1']);
});

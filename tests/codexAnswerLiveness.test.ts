// A Codex answer reaches the app-server only for a card main holds for it now: never a card answered, withdrawn,
// another harness's, or one from before an app-server restart (whose ids start again at 0) (#1866).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');

/** Chats by id: 'cl…' Claude Code, anything else Codex. */
function setup(o: { ids?: string[] } = {}) {
  const kindOf = (id: string) => (id.startsWith('cl') ? 'claude' : 'codex');
  const rec = (id: string) => ({ id, segments: [{ kind: kindOf(id), nativeId: id }] });
  const records = new Map((o.ids ?? ['cx1']).map((id) => [id, rec(id)]));
  const state = new SessionStore();
  const c = new ChatController({ state, chats: { record: rec, records }, codex: {}, claudeTurns: {}, acpTurns: {} });
  return { c, state, s: (id: string) => state.get(id) };
}

test('onCodexOutgoing sends only an answer to a card main holds for the running app-server, once', () => {
  const { c, state, s } = setup({ ids: ['cx1', 'cl1'] });
  for (const id of ['cx1', 'cl1']) state.patch(id, { turn: 'running' });
  c.addApproval('cx1', { id: 0, method: 'item/commandExecution/requestApproval', params: {}, source: { kind: 'codex' } });
  // the same id on another harness's card is that harness's to answer, never Codex's
  c.addApproval('cl1', { id: 7, method: 'claude/permission', params: {}, source: { kind: 'claude', key: 'cl1' } });
  assert.equal(c.onCodexOutgoing({ id: 7, result: {} }), false);
  assert.equal(s('cl1').approvals.length, 1);
  // a card main never held (or a bare message) is not forwarded
  assert.equal(c.onCodexOutgoing({ id: 99, result: {} }), false);
  assert.equal(c.onCodexOutgoing(null), false);
  assert.equal(c.onCodexOutgoing({ result: {} }), false);
  // an error answer counts as the answer; a second window's answer is dropped
  assert.equal(c.onCodexOutgoing({ id: 0, error: { code: 1 } }), true);
  assert.equal(s('cx1').approvals.length, 0);
  assert.equal(s('cx1').turn, 'running');
  assert.equal(c.onCodexOutgoing({ id: 0, result: {} }), false);
  // an owner entry outliving its card (the list replaced by a direct patch) names nothing live either
  c.addApproval('cx1', { id: 1, method: 'item/commandExecution/requestApproval', params: {}, source: { kind: 'codex' } });
  state.patch('cx1', { approvals: [] });
  assert.equal(c.onCodexOutgoing({ id: 1, result: {} }), false);
});

test('onCodexOutgoing: a card from before an app-server restart cannot answer the new server request with its id', () => {
  const { c, state, s } = setup();
  state.patch('cx1', { turn: 'running' });
  c.addApproval('cx1', { id: 0, method: 'item/commandExecution/requestApproval', params: { old: true }, source: { kind: 'codex' } });
  assert.equal(s('cx1').turn, 'awaitingUser');
  c.onCodexExit();
  assert.deepEqual(s('cx1').approvals, []);
  // the stale card's answer arrives after the restart: retired, not sent
  assert.equal(c.onCodexOutgoing({ id: 0, result: { decision: 'accept' } }), false);
  // the new app-server asks again with the same id: only the card for that request takes the answer
  state.patch('cx1', { turn: 'running', crashed: null });
  c.onCodexMessage({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'cx1', fresh: true } });
  assert.deepEqual(
    s('cx1').approvals.map((a: any) => a.params.fresh),
    [true],
  );
  assert.equal(c.onCodexOutgoing({ id: 0, result: { decision: 'accept' } }), true);
  assert.equal(c.onCodexOutgoing({ id: 0, result: { decision: 'accept' } }), false);
});

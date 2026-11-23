// The Claude session's Remote Control report reaches the chat's state (electron/session/controllerEvents.cjs): the
// session's own report in the shape the window reads, and nothing from a process that isn't the chat's current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');

test("the link as the session reports it, and not a replaced process's", () => {
  // the chat's earlier Claude session is no longer its current one
  const rec = (id: string) => ({
    id,
    segments: [
      { kind: 'claude', nativeId: 'old' },
      { kind: 'claude', nativeId: id },
    ],
  });
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: { record: rec, records: new Map([['cl1', rec('cl1')]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
  });
  const remote = () => state.get('cl1').remoteControl;
  assert.equal(remote(), null);
  const url = 'https://claude.ai/code/session_a';
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'remoteControl', state: 'on', url, error: null, wanted: true });
  assert.deepEqual(remote(), { state: 'on', url, error: null, wanted: true });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'remoteControl', state: 'error', url: null, error: 'timed out', wanted: true });
  assert.deepEqual(remote(), { state: 'error', url: null, error: 'timed out', wanted: true });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'remoteControl', state: 'off' });
  assert.deepEqual(remote(), { state: 'off', url: null, error: null, wanted: false });
  c.onClaudeEvent({ key: 'claude:old', kind: 'remoteControl', state: 'on', url, wanted: true });
  assert.equal(remote().state, 'off');
});

// A card cancelled by an agent's event leaves only that chat's cards (electron/session/controllerApprovals.cjs, controllerEvents.cjs): a chat, and so a Host's chat, cannot cancel another chat's approval by naming its id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function rig() {
  const records = new Map<string, any>();
  for (const id of ['acp:kimi:a', 'acp:kimi:b', 'claude:c', 'claude:d'])
    records.set(id, { id, segments: [{ kind: id.startsWith('acp') ? 'acp' : 'claude', nativeId: id, start: 0, count: null }] });
  const state = new SessionStore();
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    labelOf: () => 'Agent',
    notify: () => undefined,
  });
  const card = (id: string) => ({ id, method: 'acp/permission', params: { options: [] } });
  const ids = (chatId: string) => state.get(chatId).approvals.map((a: any) => a.id);
  return { controller, state, card, ids };
}

test('resolveApproval with a chat leaves other chats’ cards alone; without one it still finds the card anywhere (an answer from a window)', () => {
  const { controller, card, ids } = rig();
  controller.addApproval('acp:kimi:a', card('p1'));
  controller.addApproval('acp:kimi:b', card('p2'));
  assert.equal(controller.resolveApproval('p1', 'acp:kimi:b'), false, 'chat b has no p1');
  assert.deepEqual(ids('acp:kimi:a'), ['p1']);
  assert.equal(controller.resolveApproval('p1', 'acp:kimi:a'), true);
  assert.deepEqual(ids('acp:kimi:a'), []);
  assert.equal(controller.resolveApproval('p2'), true, 'an answer names only the card');
  assert.deepEqual(ids('acp:kimi:b'), []);
});

test('an ACP chat’s permissionCancelled for another chat’s card id changes nothing there; its own card is cancelled', () => {
  const { controller, card, ids } = rig();
  controller.addApproval('acp:kimi:a', card('p1'));
  controller.addApproval('acp:kimi:b', card('p2'));
  controller.onAcpEvent({ kind: 'permissionCancelled', requestId: 'p1', key: 'acp:kimi:b' });
  assert.deepEqual(ids('acp:kimi:a'), ['p1'], 'b cannot cancel a’s card');
  controller.onAcpEvent({ kind: 'permissionCancelled', requestId: 'p2', key: 'acp:kimi:b' });
  assert.deepEqual(ids('acp:kimi:b'), []);
});

test('a Claude chat’s permissionCancelled for another chat’s card id changes nothing there', () => {
  const { controller, card, ids } = rig();
  controller.addApproval('claude:c', { ...card('q1'), method: 'claude/permission' });
  controller.addApproval('claude:d', { ...card('q2'), method: 'claude/permission' });
  controller.onClaudeEvent({ kind: 'permissionCancelled', requestId: 'q1', key: 'claude:d' });
  assert.deepEqual(ids('claude:c'), ['q1']);
  controller.onClaudeEvent({ kind: 'permissionCancelled', requestId: 'q2', key: 'claude:d' });
  assert.deepEqual(ids('claude:d'), []);
});

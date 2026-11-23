// "Needs your approval" is said once per need: a chat that already waits on the person says nothing for the cards that join it, a card that was answered lets the next one say it again, and other chats have their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function rig() {
  const records = new Map<string, any>();
  for (const id of ['claude:a', 'claude:b']) records.set(id, { id, segments: [{ kind: 'claude', nativeId: id, start: 0, count: null }] });
  const state = new SessionStore();
  const said: [string, string][] = [];
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    labelOf: () => 'Claude Code',
    notify: (kind: string, chatId: string, note: any) => said.push([chatId, `${kind}:${note.cardId}`]),
  });
  const card = (id: string) => ({ id, method: 'item/commandExecution/requestApproval', params: { command: id } });
  return { controller, state, said, card };
}

test('a chat that already waits on the person says nothing for the cards that join it; an answer lets the next one speak', () => {
  const { controller, said, card } = rig();
  controller.addApproval('claude:a', card('1'));
  controller.addApproval('claude:a', card('2'));
  controller.addApproval('claude:a', card('3'));
  assert.deepEqual(said, [['claude:a', 'approval:1']], 'one notice for the need, however many cards it holds');
  // the same card again is the same card
  controller.addApproval('claude:a', card('1'));
  assert.equal(said.length, 1);
  // some answered, one still waits: still the same need
  controller.resolveApproval('1');
  controller.resolveApproval('2');
  controller.addApproval('claude:a', card('4'));
  assert.equal(said.length, 1);
  // all answered: a card that comes after is a new need
  controller.resolveApproval('3');
  controller.resolveApproval('4');
  controller.addApproval('claude:a', card('5'));
  assert.deepEqual(said.at(-1), ['claude:a', 'approval:5']);
  assert.equal(said.length, 2);
});

test('another chat has its own need: a card there is said while the first chat waits', () => {
  const { controller, said, card } = rig();
  controller.addApproval('claude:a', card('1'));
  controller.addApproval('claude:b', card('2'));
  controller.addApproval('claude:a', card('3'));
  assert.deepEqual(said, [
    ['claude:a', 'approval:1'],
    ['claude:b', 'approval:2'],
  ]);
});

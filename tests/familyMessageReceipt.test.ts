// Another session's message to a running chat: the sender's receipt (service.cjs message) and a follow-up to a running
// child (scheduler.cjs deliverToChild) follow ChatController.deliverFamily's outcome — steered is delivered, anything else
// is queued with the reason — and a queued one the user removes is still recorded for its sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { queuedNote, QUEUED_NOTE } = require('../electron/session/orchestration/userRemoval.cjs');

async function pair(deliver: (id: string, item: any) => Promise<any>, wait: string | null = null) {
  const h = orchestration();
  h.userTurn();
  const a = (await h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'a', use_worktree: false })).chat_id;
  const b = (await h.orch.start('top', { background: BACKGROUND, title: 'B', prompt: 'b', use_worktree: false })).chat_id;
  const calls: any[] = [];
  const route = async (id: string, item: any) => (calls.push([id, item.id]), deliver(id, item));
  h.controller.deliverFamily = route;
  h.orch.o.deliverFamily = route;
  (h.controller as any).familyWait = () => wait;
  return { ...h, a, b, calls };
}

test('a sibling message that steered into the running turn is delivered with no note', async () => {
  const h = await pair(async () => ({ started: true, steered: true }));
  const receipt = await h.orch.message(h.a, { to: h.b, message: 'mid-turn' });
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.note, undefined);
  assert.deepEqual(h.calls, [[h.b, receipt.message_id]]);
});

test('a message that waits names why in its queued receipt, and the cause when the harness refused', async () => {
  for (const [waitingFor, text] of [
    ['no_steer', 'it cannot take a message during a turn'],
    ['awaiting_user', 'it is waiting for the user'],
    ['switch_pending', 'it is switching harness'],
    ['earlier_queued', 'an earlier message waits ahead of it'],
    ['compaction', 'it is compacting'],
    ['voiceConversation', 'a voice conversation is active there'],
  ]) {
    const h = await pair(async () => ({ started: false, queued: true, waitingFor }));
    const receipt = await h.orch.message(h.a, { to: h.b, message: 'later' });
    assert.equal(receipt.status, 'queued');
    assert.match(receipt.note, new RegExp(text));
    assert.match(receipt.note, /list_sessions then lists it under removed_messages/);
  }
  const refused = await pair(async () => ({ started: false, queued: true, error: 'steer refused' }));
  const receipt = await refused.orch.message(refused.a, { to: refused.b, message: 'x' });
  assert.deepEqual([receipt.status, receipt.error, receipt.note], ['queued', 'steer refused', QUEUED_NOTE]);
});

test('queuedNote falls back to the generic note for an unknown or missing reason', () => {
  assert.equal(queuedNote(), QUEUED_NOTE);
  assert.equal(queuedNote('something_else'), QUEUED_NOTE);
});

test('a queued family message the user removes is still recorded as removed for its sender', async () => {
  const h = await pair(async () => ({ started: false, queued: true, waitingFor: 'no_steer' }));
  const receipt = await h.orch.message(h.a, { to: h.b, message: 'oops' });
  h.orch.queuedRemoved(h.b, { sideSession: { id: receipt.message_id } });
  assert.ok(h.journal.data.deliveries[receipt.message_id].removedAt);
  assert.equal(h.journal.data.deliveries[receipt.message_id].removedReason, 'user');
});

test('a follow-up to a running child that can steer goes in at once with no queue position', async () => {
  const h = await pair(async () => ({ started: true, steered: true }));
  h.states.set(h.b, { turn: 'running', activeTurn: { id: 't' } });
  const receipt = await h.orch.message('top', { to: h.b, message: 'change course' });
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.queue_position, undefined);
  assert.equal(h.journal.data.queue.length, 0);
  assert.equal(h.calls.length, 1);
});

test('a running child that cannot take the message now waits in the journal queue with its position', async () => {
  const h = await pair(async () => ({ started: true, steered: true }), 'no_steer');
  h.states.set(h.b, { turn: 'running', activeTurn: { id: 't' } });
  const receipt = await h.orch.message('top', { to: h.b, message: 'wait' });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.queue_position, 1);
  assert.equal(h.calls.length, 0);
});

test('a follow-up never steers past an older message in the journal queue, and none steers while a send to the child is in flight', async () => {
  const h = await pair(async () => ({ started: true, steered: true }));
  h.states.set(h.b, { turn: 'running', activeTurn: { id: 't' } });
  h.journal.change((d: any) => d.queue.push({ id: 'older', chatId: h.a, item: { id: 'older', text: 'x' }, at: 1 }));
  const receipt = await h.orch.message('top', { to: h.b, message: 'behind' });
  assert.equal(receipt.status, 'queued');
  assert.deepEqual(
    h.calls.filter(([id]: string[]) => id === h.b),
    [],
  );
  h.journal.change((d: any) => (d.queue = []));
  h.orch.childDeliveryChats = new Map([[h.b, 1]]);
  assert.equal((await h.orch.message('top', { to: h.b, message: 'during' })).status, 'queued');
  assert.equal(h.calls.filter(([id]: string[]) => id === h.b).length, 0);
});

test('a seam without deliverFamily keeps the old wait for a running child', async () => {
  const h = await pair(async () => ({ started: true, steered: true }));
  h.orch.o.deliverFamily = undefined;
  h.states.set(h.b, { turn: 'running', activeTurn: { id: 't' } });
  assert.equal((await h.orch.message('top', { to: h.b, message: 'old' })).status, 'queued');
});

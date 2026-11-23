// A chat's queued items leaving it without running because it was archived or deleted (userRemoval.cjs queueDropped):
// a message is recorded as removed for its sender with the reason, and a wake-up's notes are not lost (#3200).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';

const link = (parentId: string, name: string, driven: string[] = []) => ({
  parentId,
  name,
  title: name.toUpperCase(),
  createdAt: 1,
  driven,
  lastReport: null,
});

/** `top` started a and b; a sent b a message that waits in b's queue (live), and another one that waits in the journal's. */
function queued() {
  const h = orchestration();
  h.journal.change((d: any) => {
    d.children = { a: link('top', 'a'), b: link('top', 'b') };
    d.deliveries.live = { kind: 'message', chatId: 'b', from: 'a', body: 'live one', at: 1 };
    d.deliveries.held = { kind: 'message', chatId: 'b', from: 'a', body: 'journal one', at: 1 };
    d.queue.push({ id: 'held', chatId: 'b', item: { id: 'held', text: 'journal one' }, at: 1 });
  });
  for (const id of ['a', 'b']) h.records.set(id, { meta: {} });
  h.states.set('b', {
    queue: [
      { id: 'live', text: 'live one', sideSession: { id: 'live' } },
      { id: 'own', text: 'typed by the user' },
    ],
  });
  return h;
}

test('a recipient archived with a message in the journal queue: the sender is told it was dropped, and why', () => {
  const h = queued();
  h.records.get('b').meta.archived = 5;
  h.orch.pump();
  assert.deepEqual(h.orch.list('a').removed_messages, [{ message_id: 'held', to: 'b', reason: 'archived', body: 'journal one' }]);
  assert.equal(h.journal.data.queue.length, 0);
});

test('a recipient deleted: its live and journal-queued messages are recorded for the sender, which keeps them after the chat is forgotten', () => {
  const h = queued();
  h.deleted.add('b');
  h.orch.chatDeleted('b');
  const removed = h.orch.list('a').removed_messages;
  assert.deepEqual(removed.map((m: any) => [m.message_id, m.reason]).sort(), [
    ['held', 'deleted'],
    ['live', 'deleted'],
  ]);
  assert.equal(h.journal.child('b'), null, 'the chat itself is forgotten');
  assert.deepEqual(Object.keys(h.journal.data.deliveries).sort(), ['held', 'live']);
  h.orch.chatDeleted('b');
  assert.equal(h.orch.list('a').removed_messages.length, 2, 'a second pass records nothing more');
});

test('a message that already ran is not claimed as removed when its recipient is deleted', () => {
  const h = queued();
  h.states.set('b', { queue: [] });
  h.journal.change((d: any) => {
    d.queue = [];
  });
  h.deleted.add('b');
  h.orch.chatDeleted('b');
  assert.equal(h.orch.list('a').removed_messages, undefined);
  assert.deepEqual(Object.keys(h.journal.data.deliveries), []);
});

test('a parent deleted with a wake-up queued: its notes go up to the session above it, not lost', () => {
  const h = orchestration();
  h.journal.change((d: any) => {
    d.children = { mid: link('top', 'mid'), leaf: link('mid', 'leaf') };
    d.parents.mid = { wakes: 1, held: false, cutShort: false, notes: [] };
    d.deliveries.wake = { kind: 'wake', chatId: 'mid', at: 1, notes: [{ childId: 'leaf', body: 'leaf is done' }] };
  });
  for (const id of ['mid', 'leaf']) h.records.set(id, { meta: {} });
  h.states.set('mid', { queue: [{ id: 'wake', text: 'w', sideSession: { id: 'wake' } }] });
  h.deleted.add('mid');
  h.orch.chatDeleted('mid');
  assert.ok(h.journal.parent('top').notes.some((n: any) => n.childId === 'leaf' && n.body.includes('leaf is done')));
  assert.equal(h.journal.data.deliveries.wake, undefined, "the deleted parent's own record is forgotten");
});

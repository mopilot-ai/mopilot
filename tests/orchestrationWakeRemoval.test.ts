// The user removing a wake-up from its parent's queue (userRemoval.cjs wakeRemoved): the notes the wake carried go back
// to the parent's record and the wake no longer holds the next one back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';

const link = (parentId: string, name: string, driven: string[]) => ({
  parentId,
  name,
  title: name.toUpperCase(),
  createdAt: 1,
  driven,
  lastReport: null,
});

/** `top` with children a and b; a's driven turn finished, so `top` was woken and the harness left the wake queued. */
function woken() {
  const h = orchestration();
  h.journal.change((d: any) => {
    d.children = { a: link('top', 'a', ['b-a']), b: link('top', 'b', ['b-b']) };
  });
  for (const id of ['a', 'b']) h.records.set(id, { meta: {} });
  h.orch.finished({ chatId: 'a', inputToken: 'pending-b-a', text: 'a is done', completed: true });
  h.flush();
  const wake = h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top').map((l: any) => l[2])[0];
  return { ...h, wake };
}

test('a wake the user removes from the parent’s queue gives its notes back', () => {
  const h = woken();
  assert.ok(h.wake.text.includes('a is done'));
  assert.equal(h.journal.parent('top').notes.length, 0, 'the wake carried the note');
  assert.equal(h.orch.waking.get('top'), h.wake.id);
  assert.equal(h.orch.queuedRemoved('top', h.wake), true);
  const p = h.journal.parent('top');
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0].body, /a is done/);
  assert.equal(p.notes[0].childId, 'a');
  assert.equal(p.notes[0].wakes, false, 'the user said no to that wake: nothing wakes the parent again by itself');
  assert.equal(p.wakes, 0, 'the wake never ran, so it does not count toward the cap');
  assert.equal(h.orch.waking.has('top'), false);
  assert.equal(typeof h.journal.data.deliveries[h.wake.id].removedAt, 'number');
  h.flush();
  assert.equal(h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top').length, 1, 'no second wake');
});

test('the restored notes arrive with the next wake', () => {
  const h = woken();
  h.orch.queuedRemoved('top', h.wake);
  h.orch.finished({ chatId: 'b', inputToken: 'pending-b-b', text: 'b is done', completed: true });
  h.flush();
  const next = h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top').map((l: any) => l[2])[1];
  assert.ok(next.text.includes('a is done') && next.text.includes('b is done'), 'the earlier note is not lost');
});

test('a removed wake is restored once, only from its own chat’s queue, and a newer wake keeps its mark', () => {
  const h = woken();
  assert.equal(h.orch.queuedRemoved('a', h.wake), false, 'another chat’s queue');
  assert.equal(h.journal.parent('top').notes.length, 0);
  h.orch.waking.set('top', 'newer-wake');
  assert.equal(h.orch.queuedRemoved('top', h.wake), true);
  assert.equal(h.orch.waking.get('top'), 'newer-wake');
  assert.equal(h.orch.queuedRemoved('top', h.wake), false, 'a second removal restores nothing');
  assert.equal(h.journal.parent('top').notes.length, 1);
});

test('a parent’s record the journal no longer holds is rebuilt, and the notes stay within the kept count', () => {
  const h = woken();
  h.journal.change((d: any) => {
    delete d.parents.top;
    d.parents.top = {
      wakes: 0,
      held: false,
      cutShort: false,
      notes: Array.from({ length: 32 }, (_, i) => ({ childId: 'b', body: `n${i}`, at: i, wakes: false })),
    };
  });
  h.orch.queuedRemoved('top', h.wake);
  const notes = h.journal.parent('top').notes;
  assert.equal(notes.length, 32);
  assert.equal(notes.at(-1).body, 'n31', 'the newest notes are the ones kept');
  const gone = woken();
  gone.journal.change((d: any) => delete d.parents.top);
  assert.equal(gone.orch.queuedRemoved('top', gone.wake), true);
  assert.equal(gone.journal.parent('top').notes.length, 1);
});

test('a journal that cannot record the removal still frees the parent for its next wake', () => {
  const h = woken();
  h.orch.safely = () => false;
  assert.equal(h.orch.queuedRemoved('top', h.wake), false);
  assert.equal(h.orch.waking.has('top'), false, 'the removed wake is not waited on');
});

test('a wakeable note that came while the wake waited wakes the parent once the wake is removed', () => {
  const h = woken();
  h.orch.finished({ chatId: 'b', inputToken: 'pending-b-b', text: 'b is done', completed: true });
  h.flush();
  assert.equal(h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top').length, 1, 'the queued wake holds the next one back');
  h.orch.queuedRemoved('top', h.wake);
  h.flush();
  const next = h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top').map((l: any) => l[2])[1];
  assert.ok(next.text.includes('a is done') && next.text.includes('b is done'), 'the restored note rides with the new one');
  assert.equal(h.journal.parent('top').notes.length, 0);
});

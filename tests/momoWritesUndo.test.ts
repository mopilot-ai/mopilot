// The user's own Undo and the Memory tab's list of what MoMo wrote (#2139 P5, sources/write.cjs written() and undoByUser()), through the shared rig of tests/support/momo-writes-rig.ts: no card for the user's act, audited as intent then outcome, honest about a changed item, a helper that can't delete or stops answering, a source no longer connected and an audit log that can't be written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, helperError, NOW, EVENT, ADD } from './support/momo-writes-rig.ts';

test('the Memory tab lists what MoMo wrote and tells the window each time the list changes', async () => {
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Dentist', start: '2026-11-12T15:00', end: '2026-11-12T16:00' }));
  await r.allow(r.run(ADD, { title: 'Milk', due: '2026-11-11' }));
  assert.equal(r.changes.length, 2);
  const rows = r.writer.written();
  assert.deepEqual(
    rows.map((w: any) => [w.kind, w.title, w.start !== undefined, w.due !== undefined, w.undone]),
    [
      ['reminder', 'Milk', false, true, undefined],
      ['event', 'Dentist', true, false, undefined],
    ],
  );
});

test("the user's own Undo needs no card, is audited as intent then outcome, and marks the write undone", async () => {
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Dentist', start: '2026-11-12T15:00', end: '2026-11-12T16:00' }));
  const w = r.ledger.list()[0];
  const before = r.entries().length;
  await r.writer.undoByUser(w.id);
  assert.equal(r.cards.length, 1, 'no card for the user’s own act');
  assert.deepEqual(r.wrote().at(-1), { method: 'calendar.delete', params: { id: w.itemId, expect: { title: 'Dentist', start: w.start } } });
  assert.deepEqual(
    r
      .entries()
      .slice(before)
      .map((e: any) => [e.kind, e.decision ?? e.result, e.chatId]),
    [
      ['intent', 'user', 'user'],
      ['outcome', 'done', 'user'],
    ],
  );
  assert.equal(r.writer.written()[0].undone, NOW);
  assert.equal(r.changes.length, 2);
  await assert.rejects(r.writer.undoByUser(w.id), (e: any) => /already undone/.test(e.message));
  await assert.rejects(r.writer.undoByUser('nope'), (e: any) => /gone or older than 30 days/.test(e.message));
});

test('the user’s Undo says why when the item changed, the helper cannot delete or stops answering, and leaves the write undoable', async () => {
  const cases: [string, unknown, RegExp, string][] = [
    ['changed', helperError('changed'), /changed or removed since, so it was left alone/, 'not sent'],
    ['old helper', helperError('method_not_found'), /helper is too old/, 'not sent'],
    ['no access', helperError('not_granted'), /macOS access to it was turned off/, 'not sent'],
    ['unknown reason', Object.assign(new Error('x'), { reason: 'bad_args' }), /No calendar, list or item/, 'not sent'],
    ['timeout', new Error('timed out'), /may or may not have been taken back/, 'uncertain'],
  ];
  for (const [name, error, re, result] of cases) {
    const r = rig();
    await r.allow(r.run(ADD, { title: name }));
    const w = r.ledger.list()[0];
    r.fail['reminders.delete'] = error;
    await assert.rejects(r.writer.undoByUser(w.id), (e: any) => re.test(e.message), name);
    assert.equal(r.entries().at(-1).result, result, name);
    assert.equal(r.ledger.get(w.id).undone, undefined, name);
  }
  // a source that is no longer connected, and an audit log that can't be written
  const gone = rig();
  await gone.allow(gone.run(ADD, { title: 'x' }));
  const id = gone.ledger.list()[0].id;
  gone.f.hub.disconnect('reminders');
  await assert.rejects(gone.writer.undoByUser(id), (e: any) => e.code === 'not_connected');
  const noAudit = rig();
  await noAudit.allow(noAudit.run(ADD, { title: 'y' }));
  const id2 = noAudit.ledger.list()[0].id;
  const orig = noAudit.audit.available;
  noAudit.audit.available = () => false;
  await assert.rejects(noAudit.writer.undoByUser(id2), (e: any) => /audit log can't be written/.test(e.message));
  noAudit.audit.available = orig;
});

test("a user's Undo whose outcome can't be recorded still tells the truth about the item", async () => {
  const r = rig();
  await r.allow(r.run(ADD, { title: 'Milk' }));
  const id = r.ledger.list()[0].id;
  r.audit.outcome = async () => {
    throw new Error('disk full');
  };
  await r.writer.undoByUser(id);
  assert.notEqual(r.ledger.get(id).undone, undefined);
});

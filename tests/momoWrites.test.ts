// MoMo's writes to Calendar and Reminders (#2139 P5, sources/write.cjs, writeTools.cjs, writeLedger.cjs) through the real trust gate, sentinel, audit log, approval card, sources hub and a fake EventKit helper: Read only and Blocked never write, an ask-level write shows a card of exactly what will be written, a remembered approval is bound to that exact item, the audit log has the intent before the helper runs, a source changed while the card waited is left alone, and undo touches only what MoMo wrote while it still matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, until, helperError, NOW, EVENT, ADD, DONE, UNDO } from './support/momo-writes-rig.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { eventArgs, reminderArgs } = require('../electron/momo/sources/write.cjs');
const { registerWriteTools } = require('../electron/momo/sources/writeTools.cjs');
const { WriteLedger, shapeOf, KEEP_MS } = require('../electron/momo/sources/writeLedger.cjs');
const { trustClassOf } = require('../electron/momo/toolTrust.cjs');
const { OWN_LINES } = require('../shared/ownToolLines.mjs');

test('an event: the card shows exactly what will be written, the audit has the intent first, the helper gets the exact item', async () => {
  const r = rig();
  const p = r.allow(
    r.run(EVENT, { title: '  Dentist  ', start: '2026-11-12T15:00', end: '2026-11-12T16:00', calendar: 'Work', location: 'Main St' }),
  );
  await until(() => r.cards.length === 1);
  const card = r.cards[0].params.momo;
  assert.equal(card.summary, 'Dentist — 2026-11-12 15:00–16:00 · Work');
  assert.equal(card.source, 'Calendar');
  assert.equal(card.action, 'change');
  assert.deepEqual(r.wrote(), []);
  const text = await p;
  assert.match(String(text), /^Added to Calendar\. To undo it, call momo_undo_write with id w\d+\.$/);
  assert.deepEqual(r.wrote(), [
    {
      method: 'calendar.create',
      params: {
        title: 'Dentist',
        start: new Date(2026, 10, 12, 15).getTime(),
        end: new Date(2026, 10, 12, 16).getTime(),
        allDay: false,
        calendarId: 'cal-work',
        location: 'Main St',
      },
    },
  ]);
  assert.deepEqual(
    r.entries().map((e: any) => [e.kind, e.decision ?? e.result]),
    [
      ['intent', 'asked:once'],
      ['outcome', 'done'],
    ],
  );
  const kept = r.ledger.list();
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0].kind, kept[0].title, kept[0].itemId], ['event', 'Dentist', 'ev-1']);
});

test('Read only and Blocked never write and show no card', async () => {
  for (const level of ['read', 'blocked'] as const) {
    const r = rig({ level });
    await assert.rejects(
      r.run(EVENT, { title: 'x', start: '2026-11-12T15:00' }),
      (e: any) => e.code === 'refused' && /nothing was changed|blocked/.test(e.message),
    );
    await assert.rejects(r.run(ADD, { title: 'x' }), (e: any) => /nothing was changed|blocked/.test(e.message));
    assert.equal(r.cards.length, 0);
    assert.deepEqual(r.wrote(), []);
    assert.equal(r.entries().at(-1).kind, 'refusal');
  }
});

test('a source that is not connected, or a routine that does not use it, is refused before any card', async () => {
  const r = rig();
  r.f.hub.disconnect('calendar');
  await assert.rejects(r.run(EVENT, { title: 'x', start: '2026-11-12T15:00' }), (e: any) => e.code === 'not_connected');
  const s = rig();
  s.f.hub.setScope(async () => ({ name: 'Morning', sources: ['reminders'] }));
  await assert.rejects(
    s.run(EVENT, { title: 'x', start: '2026-11-12T15:00' }),
    (e: any) => e.code === 'refused' && /routine/.test(e.message),
  );
  assert.equal(s.cards.length, 0);
  // a routine that names the source asks like a chat does
  const t = await s.allow(s.run(ADD, { title: 'Water plants' }));
  assert.match(String(t), /^Reminder added\./);
});

test('a remembered approval is bound to the exact item: the same asks no more, another title asks again', async () => {
  const r = rig();
  await r.allow(r.run(ADD, { title: 'Call landlord', due: '2026-11-11' }), 'chat');
  assert.match(String(await r.run(ADD, { title: 'Call landlord', due: '2026-11-11' })), /^Reminder added/);
  assert.equal(r.cards.length, 1);
  const p = r.allow(r.run(ADD, { title: 'Call the bank', due: '2026-11-11' }));
  await p;
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[1].params.momo.summary, 'Call the bank — due 2026-11-11');
  assert.equal(r.wrote().length, 3);
  assert.equal(r.wrote()[0].params.dueAllDay, true);
});

test('Deny tells the model not to retry, and nothing is written', async () => {
  const r = rig();
  const p = r.run(ADD, { title: 'x' });
  await until(() => r.cards.length === 1);
  r.broker.answer(r.cards[0].id, { decision: 'deny' });
  await assert.rejects(p, (e: any) => /Don't retry/.test(e.message));
  assert.deepEqual(r.wrote(), []);
});

test('a stopped call withdraws its card', async () => {
  const r = rig();
  const ac = new AbortController();
  const p = r.run(ADD, { title: 'x' }, 'momo-main', ac.signal);
  await until(() => r.cards.length === 1);
  ac.abort();
  await assert.rejects(p, (e: any) => /Nobody answered/.test(e.message));
  assert.deepEqual(r.wrote(), []);
});

test('a source changed while the card waited is left alone, audited as not sent', async () => {
  for (const change of [
    (r: any) => r.f.hub.setLevel('reminders', 'read'),
    (r: any) => r.f.hub.disconnect('reminders'),
    (r: any) => r.f.hub.setScope(async () => ({ name: 'R', sources: ['calendar'] })),
  ]) {
    const r = rig();
    const p = r.run(ADD, { title: 'x' });
    await until(() => r.cards.length === 1);
    change(r);
    r.broker.answer(r.cards[0].id, { decision: 'allow', scope: 'once' });
    await assert.rejects(p, (e: any) => /Nothing was sent\. Access to the source changed/.test(e.message));
    assert.deepEqual(r.wrote(), []);
    assert.deepEqual(r.entries().at(-1).result, 'not sent');
  }
});

test('all-day and default times, and what a bad argument says', async () => {
  assert.deepEqual(eventArgs({ title: 'Holiday', start: '2026-11-12' }), {
    title: 'Holiday',
    start: new Date(2026, 10, 12).getTime(),
    end: new Date(2026, 10, 13).getTime(),
    allDay: true,
  });
  const timed = eventArgs({ title: 'Call', start: '2026-11-12T09:00', allDay: false });
  assert.equal(timed.end - timed.start, 3_600_000);
  assert.equal(eventArgs({ title: 'a', start: '2026-11-12', end: '2026-11-14T10:00' }).allDay, false);
  assert.equal(eventArgs({ title: 'a', start: '2026-11-12', end: '2026-11-14' }).allDay, true);
  assert.deepEqual(reminderArgs({ title: ' Pay  rent ', list: 'Home' }), { title: 'Pay rent', list: 'Home' });
  assert.equal(reminderArgs({ title: 'x', due: '2026-11-11T09:00' }).dueAllDay, false);
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e: any) {
      return e.code + ':' + e.message;
    }
    return 'no error';
  };
  assert.equal(
    msg(() => eventArgs({ start: '2026-11-12' })),
    'bad_args:title is required',
  );
  assert.equal(
    msg(() => eventArgs({ title: '   ', start: '2026-11-12' })),
    'bad_args:title is required',
  );
  assert.equal(
    msg(() => eventArgs({ title: 5, start: '2026-11-12' })),
    'bad_args:title must be text',
  );
  assert.equal(
    msg(() => eventArgs({ title: 'x'.repeat(201), start: '2026-11-12' })),
    'bad_args:title must be at most 200 characters',
  );
  assert.equal(
    msg(() => eventArgs({ title: 'x' })),
    'bad_args:start is required',
  );
  assert.equal(
    msg(() => eventArgs({ title: 'x', start: '2026-11-12T10:00', end: '2026-11-12T09:00' })),
    'bad_args:end must be after start',
  );
  assert.equal(
    msg(() => eventArgs({ title: 'x', start: '2026-11-12', calendar: 4 })),
    'bad_args:calendar must be text',
  );
  assert.equal(
    msg(() => eventArgs({ title: 'x', start: '2026-11-12', location: ' ' })),
    'no error',
  );
  assert.equal(
    msg(() => reminderArgs({ title: null })),
    'bad_args:title is required',
  );
  const r = rig();
  await assert.rejects(r.run(EVENT, { title: 'x' }), (e: any) => e.code === 'bad_args');
  assert.equal(r.cards.length, 0);
});

test("a calendar or list that does not exist is not sent, without naming the user's other titles", async () => {
  const r = rig();
  await assert.rejects(
    r.allow(r.run(EVENT, { title: 'x', start: '2026-11-12T10:00', calendar: 'Nope' })),
    (e: any) => /Nothing was sent\. No calendar, list or item has that name\.$/.test(e.message) && !/Work/.test(e.message),
  );
  await assert.rejects(r.allow(r.run(ADD, { title: 'x', list: 'Nope' })), (e: any) => /No calendar, list or item/.test(e.message));
  assert.deepEqual(r.wrote(), []);
});

test('complete: the card names the reminder, the helper is told what it must still be, and it can be reopened', async () => {
  const r = rig();
  const text = await r.allow(r.run(DONE, { id: 'rem-9' }));
  assert.equal(r.cards[0].params.momo.summary, 'Call landlord · Home');
  assert.match(String(text), /^Marked done\./);
  assert.deepEqual(r.wrote()[0], { method: 'reminders.complete', params: { id: 'rem-9', done: true, expect: { title: 'Call landlord' } } });
  const id = r.ledger.list()[0].id;
  const undone = await r.allow(r.run(UNDO, { id }));
  assert.equal(undone, 'Undone.');
  assert.equal(r.cards[1].params.momo.summary, 'Reopen “Call landlord”');
  assert.deepEqual(r.wrote()[1], {
    method: 'reminders.complete',
    params: { id: 'rem-9', done: false, expect: { title: 'Call landlord' } },
  });
});

test('an all-day event reads as a date on the card, a reminder can name its list, and a reminder with no list has none on the card', async () => {
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Holiday', start: '2026-11-12' }));
  assert.equal(r.cards[0].params.momo.summary, 'Holiday — 2026-11-12');
  await r.allow(r.run(ADD, { title: 'Water plants', list: 'Home' }));
  assert.equal(r.cards[1].params.momo.summary, 'Water plants · Home');
  assert.equal(r.wrote()[1].params.listId, 'list-home');
  await r.allow(r.run(DONE, { id: 'nolist' }));
  assert.equal(r.cards[2].params.momo.summary, 'Call landlord');
});

test('complete: an unknown id, a done reminder and a helper that stops answering', async () => {
  const r = rig();
  r.fail['reminders.get'] = helperError('not_found');
  await assert.rejects(r.run(DONE, { id: 'nope' }), (e: any) => e.code === 'bad_args' && /No reminder has that id/.test(e.message));
  delete r.fail['reminders.get'];
  await assert.rejects(r.run(DONE, { id: 'done-1' }), (e: any) => /already done/.test(e.message));
  await assert.rejects(r.run(DONE, {}), (e: any) => /id is required/.test(e.message));
  r.fail['reminders.get'] = new Error('timed out');
  await assert.rejects(r.run(DONE, { id: 'x' }), (e: any) => e.code === 'failed' && /The write failed: timed out/.test(e.message));
  assert.equal(r.cards.length, 0);
});

test('undo removes an event and a reminder MoMo made, once, and says when the item changed', async () => {
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Dentist', start: '2026-11-12T15:00' }));
  await r.allow(r.run(ADD, { title: 'Milk' }));
  const [reminder, event] = r.ledger.list();
  assert.equal(await r.allow(r.run(UNDO, { id: event.id })), 'Undone.');
  assert.equal(r.cards.at(-1).params.momo.summary, 'Remove “Dentist”');
  assert.deepEqual(r.wrote().at(-1), {
    method: 'calendar.delete',
    params: { id: event.itemId, expect: { title: 'Dentist', start: new Date(2026, 10, 12, 15).getTime() } },
  });
  // changed since: not touched, and still undoable later
  r.fail['reminders.delete'] = helperError('changed', 'The reminder was edited');
  await assert.rejects(r.allow(r.run(UNDO, { id: reminder.id })), (e: any) =>
    /Nothing was sent\. It was changed or removed since/.test(e.message),
  );
  assert.equal(r.ledger.get(reminder.id).undone, undefined);
  delete r.fail['reminders.delete'];
  assert.equal(await r.allow(r.run(UNDO, { id: reminder.id })), 'Undone.');
  assert.deepEqual(r.wrote().at(-1), { method: 'reminders.delete', params: { id: reminder.itemId, expect: { title: 'Milk' } } });
  // already undone, unknown, and past 30 days
  await assert.rejects(r.run(UNDO, { id: event.id }), (e: any) => /already undone/.test(e.message));
  await assert.rejects(r.run(UNDO, { id: 'zzz' }), (e: any) => /no write with that id/.test(e.message));
  await assert.rejects(r.run(UNDO, {}), (e: any) => /id is required/.test(e.message));
});

test('an entry past the undo window is dropped, so its undo is refused', async () => {
  const r = rig();
  await r.allow(r.run(ADD, { title: 'Milk' }));
  const id = r.ledger.list()[0].id;
  assert.ok(r.ledger.get(id));
  r.clock.now = NOW + KEEP_MS + 1;
  assert.equal(r.ledger.get(id), null);
  await assert.rejects(r.run(UNDO, { id }), (e: any) => /no write with that id, or it is older/.test(e.message));
});

test('what the helper does wrong: macOS refused, too old, no helper, timed out', async () => {
  const cases: [string, (r: any) => void, RegExp, string][] = [
    ['refused', (r) => (r.fail['reminders.create'] = helperError('not_granted')), /macOS access to it was turned off/, 'not sent'],
    ['old', (r) => (r.fail['reminders.create'] = helperError('method_not_found')), /helper is too old/, 'not sent'],
    ['absent', (r) => (r.fail['reminders.create'] = helperError('helper_unavailable')), /helper is too old/, 'not sent'],
    ['bad', (r) => (r.fail['reminders.create'] = helperError('bad_args')), /No calendar, list or item/, 'not sent'],
    ['gone', (r) => (r.fail['reminders.create'] = helperError('gone')), /changed or removed/, 'not sent'],
    ['timeout', (r) => (r.fail['reminders.create'] = new Error('timed out')), /may or may not have gone through/, 'uncertain'],
  ];
  for (const [name, set, re, result] of cases) {
    const r = rig();
    set(r);
    await assert.rejects(r.allow(r.run(ADD, { title: name })), (e: any) => re.test(e.message), name);
    assert.equal(r.entries().at(-1).result, result, name);
    assert.deepEqual(r.ledger.list(), []);
  }
  const none = rig({ helper: null });
  await assert.rejects(none.allow(none.run(ADD, { title: 'x' })), (e: any) => /helper is too old/.test(e.message));
});

test('a write whose undo could not be kept still says it was done', async () => {
  const r = rig();
  r.f.safe.failEncrypt = true;
  const text = await r.allow(r.run(ADD, { title: 'x' }));
  assert.equal(text, "Reminder added. It can't be undone from here.");
});

test('the tools are MoMo’s only, shown by chat, the same on every harness, and have a trust class and a line', async () => {
  const r = rig();
  for (const t of [EVENT, ADD, DONE, UNDO]) {
    const tool = r.registry.tools.get(t);
    assert.equal(tool.policy, 'act');
    assert.equal(tool.authorizesItself, true);
    assert.equal(tool.visibleTo('momo-main'), true);
    assert.equal(tool.visibleTo('code-chat'), false);
    assert.equal(trustClassOf(t), 'own');
    assert.ok(OWN_LINES[t]);
    assert.match(tool.description, /Asks the user to confirm first/);
  }
  await assert.rejects(r.run(ADD, { title: 'x' }, 'code-chat'), (e: any) => e.code === 'unavailable');
  await assert.rejects(r.run(ADD, { title: 'x' }, ''), (e: any) => e.code === 'unavailable');
  r.off();
  assert.equal(r.registry.tools.get(ADD), undefined);
});

test('a tool without an owner is refused, and a failure that is not an Error is told as failed', async () => {
  const registry = new Registry();
  registerWriteTools(registry, {
    writer: { createEvent: async () => Promise.reject('boom') } as any,
    allowed: () => true,
    isMomoChat: () => true,
  });
  await assert.rejects(
    registry.tools.get(ADD).handler({ title: 'x' }, { chatId: 'momo-main', segmentId: 's' }),
    (e: any) => e.code === 'unavailable',
  );
  const owned = new Registry();
  registerWriteTools(owned, {
    writer: { createEvent: async () => Promise.reject('boom') } as any,
    allowed: () => true,
    isMomoChat: () => true,
    owner: (c: any) => c.chatId,
  });
  await assert.rejects(
    owned.tools.get(EVENT).handler({}, { chatId: 'momo-main', segmentId: 's' }),
    (e: any) => e.code === 'failed' && e.message === 'The write failed: boom',
  );
});

test('the ledger keeps valid entries from the last 30 days, marks one undone once, and is erased by Reset', async () => {
  const kept = { id: 'a', kind: 'event', itemId: 'e', title: 't', at: NOW, chatId: 'c' };
  const shaped = shapeOf(
    { writes: [kept, { ...kept, id: 'old', at: NOW - KEEP_MS - 1 }, { id: 'bad' }, null, { ...kept, kind: 'nope' }] },
    NOW,
  );
  assert.deepEqual(shaped.writes, [kept]);
  assert.deepEqual(shapeOf('junk', NOW).writes, []);
  const r = rig();
  const id = await r.ledger.add({ kind: 'reminder', itemId: 'r', title: 'x', chatId: 'c' });
  assert.equal(await r.ledger.markUndone(id), true);
  assert.equal(await r.ledger.markUndone(id), false);
  assert.equal(await r.ledger.markUndone('missing'), false);
  const plain = new WriteLedger({ dir: r.f.dir, safeStorage: r.f.safe });
  assert.match(await plain.add({ kind: 'event', itemId: 'e', title: 'y', start: 1, chatId: 'c' }), /^[0-9a-f-]{36}$/);
  await r.ledger.erase();
  assert.deepEqual(r.ledger.list(), []);
});

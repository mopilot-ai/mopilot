// What MoMo's write arguments mean in the user's own time zone, and the failures a write can meet in the source (#2139 P5, sources/write.cjs, eventKit.cjs): a time without an offset is the user's local time, an offset is honoured, and the card shows exactly the local time that is written; an all-day event's `end` date is its last day (stored as the midnight after it, also across a clock change); a read-only calendar or list says so; macOS access taken away after connecting is "not sent" and marks the source to allow again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, helperError, EVENT, ADD } from './support/momo-writes-rig.ts';

const require = createRequire(import.meta.url);
const { eventArgs } = require('../electron/momo/sources/write.cjs');

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('a time without an offset is local, one with an offset is that instant, and the card shows the local time written', async () => {
  assert.equal(eventArgs({ title: 'a', start: '2026-11-12T15:00' }).start, local(2026, 11, 12, 15));
  assert.equal(eventArgs({ title: 'a', start: '2026-11-12T15:00:00Z' }).start, Date.UTC(2026, 10, 12, 15));
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Call', start: '2026-11-12T15:00:00Z', end: '2026-11-12T16:00:00Z' }));
  const sent = r.wrote()[0].params;
  const shown = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  assert.equal(r.cards[0].params.momo.summary, `Call — ${shown(sent.start)}–${shown(sent.end).slice(11)}`);
});

test('an all-day event: no end is one day, an end date is its last day, across a clock change too', () => {
  const day = (a: any) => eventArgs({ title: 'a', ...a });
  assert.deepEqual([day({ start: '2026-11-12' }).start, day({ start: '2026-11-12' }).end], [local(2026, 11, 12), local(2026, 11, 13)]);
  assert.equal(day({ start: '2026-11-12', end: '2026-11-12' }).end, local(2026, 11, 13));
  assert.equal(day({ start: '2026-11-12', end: '2026-11-14' }).end, local(2026, 11, 15));
  // the days around the US and EU clock changes: the next midnight, not 24 hours later
  for (const [y, m, d] of [
    [2026, 11, 1],
    [2026, 3, 8],
    [2026, 10, 25],
    [2026, 3, 29],
  ])
    assert.equal(day({ start: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }).end, local(y, m, d + 1));
  // a timed event is an hour long, and a date with a time is not all-day
  assert.equal(day({ start: '2026-11-12T09:00' }).end - day({ start: '2026-11-12T09:00' }).start, 3_600_000);
});

test('an all-day card reads as its day, or from the first to the last day', async () => {
  const r = rig();
  await r.allow(r.run(EVENT, { title: 'Holiday', start: '2026-11-12' }));
  await r.allow(r.run(EVENT, { title: 'Trip', start: '2026-11-12', end: '2026-11-14' }));
  assert.equal(r.cards[0].params.momo.summary, 'Holiday — 2026-11-12');
  assert.equal(r.cards[1].params.momo.summary, 'Trip — 2026-11-12 to 2026-11-14');
  assert.equal(r.wrote()[1].params.end, local(2026, 11, 15));
});

test('a read-only calendar or list says so, and an invalid_params answer is a bad argument, not uncertain', async () => {
  const r = rig();
  r.fail['reminders.create'] = helperError('read_only', 'that list is read-only');
  await assert.rejects(r.allow(r.run(ADD, { title: 'x' })), (e: any) =>
    /Nothing was sent\. That calendar or list is read-only\./.test(e.message),
  );
  r.fail['reminders.create'] = helperError('invalid_params');
  await assert.rejects(r.allow(r.run(ADD, { title: 'y' })), (e: any) => /No calendar, list or item has that name/.test(e.message));
  assert.equal(r.entries().at(-1).result, 'not sent');
});

test('access macOS took away after connecting is not sent and marks the source to allow again', async () => {
  const r = rig();
  r.fail['reminders.create'] = helperError('not_granted', 'Reminders access isn’t granted');
  await assert.rejects(r.allow(r.run(ADD, { title: 'x' })), (e: any) =>
    /Nothing was sent\. macOS access to it was turned off\./.test(e.message),
  );
  assert.equal(r.entries().at(-1).result, 'not sent');
  assert.equal(r.f.hub.list().find((s: any) => s.id === 'reminders').needsGrant, true);
  assert.equal(r.f.hub.list().find((s: any) => s.id === 'calendar').needsGrant, undefined);
});

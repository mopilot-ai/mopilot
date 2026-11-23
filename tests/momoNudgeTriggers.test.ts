// When an open loop is worth a nudge (#2139 P4, electron/momo/nudgeTriggers.cjs): due (a lead window, once), around a calendar event its words name (once per event), not mentioned for 14 days; at most 3 nudges (a declined one doesn't count), then one that asks whether to close it, then quiet; a date-only due follows the user's current zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  triggersFor,
  leadOf,
  dueNow,
  matchEvent,
  DECLINED,
  MAX_NUDGES,
  STALE_DAYS,
  DUE_GRACE,
  EVENT_AHEAD,
} = require('../electron/momo/nudgeTriggers.cjs');

const H = 3600_000;
const D = 24 * H;
const T0 = Date.UTC(2030, 2, 1, 12);
const loop = (o: any = {}) => ({
  id: 'L1',
  kind: 'todo',
  text: 'Renew the lease',
  quote: 'renew the lease',
  source: { chatId: 'm', harness: 'claude', turnId: 't' },
  saidAt: T0,
  tz: 'UTC',
  confidence: 'sure',
  lastMentionedAt: T0,
  state: 'open',
  nudged: [],
  ...o,
});
const at = (now: number, loops: any[], events: any[] = [], tz = 'UTC') => triggersFor(loops, { now, tz, events });

test('a due loop fires once in its lead window: a quarter of the time to due, between 2 hours and 3 days', () => {
  assert.equal(leadOf(0, 100 * D), 3 * D);
  assert.equal(leadOf(0, 4 * H), 2 * H);
  assert.equal(leadOf(0, 2 * D), 12 * H);
  const l = loop({ dueAt: T0 + 20 * D });
  assert.deepEqual(at(T0 + 16 * D, [l]), [], 'before the window');
  const [t] = at(T0 + 17 * D, [l]);
  assert.deepEqual(t, { loopId: 'L1', trigger: 'due', key: `due:L1:${T0 + 20 * D}`, at: T0 + 17 * D, dueAt: T0 + 20 * D });
  assert.deepEqual(at(T0 + 17 * D, [{ ...l, nudged: [{ at: 1, trigger: 'due', key: t.key }] }]), [], 'once');
  assert.equal(at(T0 + 20 * D + DUE_GRACE - 1, [l]).length, 1, 'still just after due');
  assert.deepEqual(at(T0 + 20 * D + DUE_GRACE, [l]), [], 'too late');
});

test('a date-only due is that day’s end in the zone the user is in now, across a time-zone move', () => {
  const l = loop({ dueAt: Date.UTC(2030, 2, 6, 4, 59), dueDay: '2030-03-05', tz: 'America/New_York' });
  assert.equal(dueNow(l, 'America/New_York'), Date.UTC(2030, 2, 6, 4, 59));
  assert.equal(dueNow(l, 'Asia/Tokyo'), Date.UTC(2030, 2, 5, 14, 59), 'the user flew to Tokyo: the 5th ends there');
  assert.equal(dueNow({ ...l, dueDay: '2031-99-99' }, 'UTC'), l.dueAt, 'a day that can’t be read keeps the kept time');
  assert.equal(dueNow(loop({ dueAt: 5 }), 'Asia/Tokyo'), 5, 'a timed due is absolute');
  // the same moment reads the due as Tokyo's or New York's end of the 5th
  const tokyo = at(Date.UTC(2030, 2, 5, 12), [l], [], 'Asia/Tokyo');
  const ny = at(Date.UTC(2030, 2, 5, 12), [l], [], 'America/New_York');
  assert.equal(tokyo[0].dueAt, Date.UTC(2030, 2, 5, 14, 59));
  assert.equal(ny[0].dueAt, Date.UTC(2030, 2, 6, 4, 59));
});

test('a date-only due across a daylight-saving change ends at 23:59 local on either side', () => {
  // US clocks spring forward on 2030-03-10
  const before = loop({ dueDay: '2030-03-09', dueAt: 0, tz: 'America/New_York' });
  const after = loop({ dueDay: '2030-03-11', dueAt: 0, tz: 'America/New_York' });
  assert.equal(dueNow(before, 'America/New_York'), Date.UTC(2030, 2, 10, 4, 59));
  assert.equal(dueNow(after, 'America/New_York'), Date.UTC(2030, 2, 12, 3, 59));
});

test('an event its words name, starting within a day, fires once per event; other events, titles and times don’t', () => {
  const l = loop({ event: 'dentist' });
  const ev = { title: 'Dentist appointment (Dr. Ray)', start: T0 + 5 * H };
  const [t] = at(
    T0,
    [l],
    [{ title: 'Dentist', start: T0 - H }, { title: 'Lunch', start: T0 + H }, ev, { title: 'dentist', start: T0 + 6 * H }],
  );
  assert.deepEqual(t, { loopId: 'L1', trigger: 'event', key: `event:L1:${ev.start}`, at: T0, event: ev });
  assert.deepEqual(at(T0, [{ ...l, nudged: [{ at: 1, trigger: 'event', key: t.key }] }], [ev]), [], 'that event once');
  assert.equal(matchEvent(l, [{ title: 'Dentist', start: T0 + EVENT_AHEAD + 1 }], T0), null, 'too far ahead');
  assert.equal(matchEvent(loop(), [{ title: 'Dentist', start: T0 + 1 }], T0), null, 'a loop that names no event');
  assert.equal(
    matchEvent(
      l,
      [
        { title: 7, start: T0 + 1 },
        { title: 'x', start: 'soon' },
      ],
      T0,
    ),
    null,
  );
  assert.equal(
    matchEvent(loop({ event: 'the meeting' }), [{ title: 'The meeting', start: T0 + 1 }], T0),
    null,
    'only common words: no tie',
  );
  assert.equal(matchEvent(loop({ event: 'Ana review' }), [{ title: 'Review with Ana', start: T0 + 1 }], T0)?.title, 'Review with Ana');
  assert.equal(matchEvent(loop({ event: 'Ana review' }), [{ title: 'Review', start: T0 + 1 }], T0), null, 'every word');
  // an undated loop with an event coming isn't stale
  assert.deepEqual(
    at(T0 + 20 * D, [{ ...l, lastMentionedAt: T0 }], [{ title: 'Dentist', start: T0 + 20 * D + H }]).map((x: any) => x.trigger),
    ['event'],
  );
});

test('an undated loop not mentioned for 14 days is brought up, then again 14 days after the last time', () => {
  const l = loop();
  assert.deepEqual(at(T0 + (STALE_DAYS * D - 1), [l]), []);
  const [t] = at(T0 + STALE_DAYS * D, [l]);
  assert.equal(t.trigger, 'stale');
  assert.equal(t.key, `stale:L1:${T0}`);
  const once = { ...l, nudged: [{ at: T0 + STALE_DAYS * D, trigger: 'stale', key: t.key }] };
  assert.deepEqual(at(T0 + 20 * D, [once]), []);
  assert.equal(at(T0 + 2 * STALE_DAYS * D, [once])[0].key, `stale:L1:${T0 + STALE_DAYS * D}`);
});

test('after MAX_NUDGES nudges a loop asks once whether to close it, then goes quiet; declined ones don’t count', () => {
  const sent = Array.from({ length: MAX_NUDGES }, (_, i) => ({ at: T0 + i, trigger: 'stale', key: `stale:${i}` }));
  const l = loop({ nudged: sent });
  assert.deepEqual(at(T0 + 100 * D, [l]), [{ loopId: 'L1', trigger: 'close', key: 'close:L1', at: T0 + 100 * D }]);
  assert.deepEqual(at(T0 + 100 * D, [{ ...l, askedClose: 5 }]), [], 'asked: quiet');
  assert.deepEqual(
    at(T0 + 100 * D, [{ ...l, nudged: [...sent, { at: 1, trigger: DECLINED, key: 'close:L1' }] }]),
    [],
    'the close question declined: quiet',
  );
  const declined = loop({ nudged: [...sent.slice(1), { at: T0, trigger: DECLINED, key: 'stale:x' }] });
  assert.equal(at(T0 + 100 * D, [declined])[0].trigger, 'stale', 'a declined nudge doesn’t count toward the cap');
});

test('closed, snoozed loops fire nothing', () => {
  const now = T0 + 100 * D;
  assert.deepEqual(at(now, [loop({ state: 'done' }), loop({ state: 'dismissed' }), loop({ snoozedUntil: now + 1 })]), []);
  assert.equal(at(now, [loop({ snoozedUntil: now })]).length, 1, 'a snooze that ended');
});

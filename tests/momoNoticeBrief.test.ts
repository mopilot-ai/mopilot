// MoMo notice brief (shared/momoNotice/brief.ts): structure and order built in code, the 50-mail note, the standing gate, the once-a-day claim and marking matters told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_WITHIN_MS,
  BRIEF_MAIL_CAP,
  briefAllowed,
  briefHasContent,
  buildBrief,
  markBriefed,
  runBrief,
  type BriefInput,
} from '../shared/momoNotice/brief.ts';
import { noticeSettings } from '../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore } from '../shared/momoNotice/memoryStore.ts';
import type { CalendarEvent, Matter } from '../shared/momoNotice/types.d.ts';

const NOW = new Date('2026-11-24T08:00:00Z');
const matter = (key: string, over: Partial<Matter> = {}): Matter => ({
  matterKey: key,
  state: 'open',
  title: `T ${key}`,
  summary: `S ${key}`,
  sources: [],
  updatedAt: '2026-11-23T10:00:00.000Z',
  ...over,
});
const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  now: NOW,
  settings: noticeSettings('UTC'),
  name: 'Du',
  matters: [],
  events: [],
  unsorted: [],
  couldNotCheck: [],
  checked: { mail: 3, byRules: 1, byModel: 2 },
  ...over,
});

test('needs-you puts held matters first, then the newest, then the key; snoozed and non-open matters stay out', () => {
  const brief = buildBrief(
    input({
      matters: [
        matter('b', { updatedAt: '2026-11-23T12:00:00.000Z' }),
        matter('a', { updatedAt: '2026-11-23T12:00:00.000Z' }),
        matter('old', { updatedAt: '2026-11-20T00:00:00.000Z' }),
        matter('held', { updatedAt: '2026-11-01T00:00:00.000Z', pendingDelivery: 'quiet_hours' }),
        matter('later', { snoozedUntil: '2026-11-25T00:00:00Z' }),
        matter('woke', { snoozedUntil: '2026-11-23T00:00:00Z', updatedAt: '2026-11-10T00:00:00.000Z' }),
        matter('done', { state: 'resolved' }),
      ],
    }),
  );
  assert.deepEqual(
    brief.needsYou.map((m) => m.matterKey),
    ['held', 'a', 'b', 'old', 'woke'],
  );
  assert.deepEqual(brief.needsYou[0], { matterKey: 'held', title: 'T held', summary: 'S held', pending: true, suspect: false });
  assert.equal(brief.needsYou[1].pending, false);
  assert.deepEqual([brief.dayKey, brief.at, brief.name], ['2026-11-24', NOW.toISOString(), 'Du']);
});

test('watching is ordered by next check, then key', () => {
  const brief = buildBrief(
    input({
      matters: [
        matter('z', { state: 'watching', nextCheck: '2026-11-26T00:00:00Z' }),
        matter('y', { state: 'watching', nextCheck: '2026-11-25T00:00:00Z' }),
        matter('x', { state: 'watching' }),
        matter('w', { state: 'watching', nextCheck: '2026-11-25T00:00:00Z' }),
      ],
    }),
  );
  assert.deepEqual(
    brief.watching.map((m) => m.matterKey),
    ['x', 'w', 'y', 'z'],
  );
  assert.equal(brief.watching[0].nextCheck, undefined);
  assert.equal(brief.watching[1].nextCheck, '2026-11-25T00:00:00Z');
});

test("today lists the local day's events by start, skipping cancelled, other days and undated ones", () => {
  const ev = (id: string, over: Partial<CalendarEvent>): CalendarEvent => ({ id, status: 'confirmed', ...over });
  const brief = buildBrief(
    input({
      events: [
        ev('late', {
          summary: 'Late',
          start: { dateTime: '2026-11-24T15:00:00Z' },
          end: { dateTime: '2026-11-24T16:00:00Z' },
          location: 'Kiln',
        }),
        ev('early', { start: { dateTime: '2026-11-24T09:00:00Z' }, end: { dateTime: '2026-11-24T09:30:00Z' } }),
        ev('tie-b', { start: { dateTime: '2026-11-24T09:00:00Z' } }),
        ev('allday', { summary: 'Fair', start: { date: '2026-11-24' }, end: { date: '2026-11-25' } }),
        ev('cancelled', { status: 'cancelled', start: { dateTime: '2026-11-24T10:00:00Z' } }),
        ev('tomorrow', { start: { dateTime: '2026-11-25T10:00:00Z' } }),
        ev('nodate', {}),
        ev('yesterday-allday', { start: { date: '2026-11-23' } }),
      ],
    }),
  );
  assert.deepEqual(
    brief.today.map((e) => e.id),
    ['allday', 'early', 'tie-b', 'late'],
  );
  assert.deepEqual(brief.today[3], {
    id: 'late',
    summary: 'Late',
    start: '2026-11-24T15:00:00Z',
    end: '2026-11-24T16:00:00Z',
    location: 'Kiln',
  });
  assert.deepEqual(brief.today[1], { id: 'early', summary: '(no title)', start: '2026-11-24T09:00:00Z', end: '2026-11-24T09:30:00Z' });
  assert.equal(brief.today[2].end, '');
});

test('the local day decides which events are today', () => {
  const event: CalendarEvent = { id: 'e', status: 'confirmed', start: { dateTime: '2026-11-24T20:00:00Z' } };
  assert.equal(buildBrief(input({ events: [event], settings: noticeSettings('UTC') })).today.length, 1);
  assert.equal(buildBrief(input({ events: [event], settings: noticeSettings('Asia/Shanghai') })).today.length, 0);
});

test('more than 50 matching mails is said under could-not-check; unsorted items and the counts pass through', () => {
  const plain = buildBrief(input({ mailMatched: BRIEF_MAIL_CAP, couldNotCheck: [{ source: 'Calendar', why: 'Not connected.' }] }));
  assert.deepEqual(plain.couldNotCheck, [{ source: 'Calendar', why: 'Not connected.' }]);
  const over = buildBrief(input({ mailMatched: 51, unsorted: [{ key: 'k', title: 'Mail', error: 'usage limit' }] }));
  assert.deepEqual(over.couldNotCheck, [{ source: 'Gmail', why: 'More than 50 mails matched, so only the newest 50 were read.' }]);
  assert.deepEqual(over.couldNotSort, [{ key: 'k', title: 'Mail', error: 'usage limit' }]);
  assert.deepEqual(over.checked, { mail: 3, byRules: 1, byModel: 2 });
});

test('a brief has something to say only with needs-you, today, unsorted or could-not-check lines', () => {
  assert.equal(briefHasContent(buildBrief(input())), false);
  assert.equal(briefHasContent(buildBrief(input({ matters: [matter('a', { state: 'watching' })] }))), false);
  assert.equal(briefHasContent(buildBrief(input({ matters: [matter('a')] }))), true);
  assert.equal(briefHasContent(buildBrief(input({ unsorted: [{ key: 'k', title: 't', error: 'e' }] }))), true);
  assert.equal(briefHasContent(buildBrief(input({ couldNotCheck: [{ source: 's', why: 'w' }] }))), true);
  assert.equal(
    briefHasContent(buildBrief(input({ events: [{ id: 'e', status: 'confirmed', start: { dateTime: '2026-11-24T10:00:00Z' } }] }))),
    true,
  );
});

const gate = (over = {}) => ({
  enabled: true,
  now: NOW,
  settings: noticeSettings('UTC'),
  lastActiveAt: new Date(NOW.getTime() - 86_400_000),
  ...over,
});

test('a brief runs only when on, outside quiet hours, and the user was active within 7 days', () => {
  assert.deepEqual(briefAllowed(gate()), { ok: true });
  assert.deepEqual(briefAllowed(gate({ enabled: false })), { ok: false, reason: 'off' });
  assert.deepEqual(briefAllowed(gate({ now: new Date('2026-11-24T07:59:00Z') })), { ok: false, reason: 'quiet_hours' });
  assert.deepEqual(briefAllowed(gate({ lastActiveAt: undefined })), { ok: false, reason: 'inactive' });
  assert.deepEqual(briefAllowed(gate({ lastActiveAt: new Date(NOW.getTime() - ACTIVE_WITHIN_MS - 1) })), { ok: false, reason: 'inactive' });
  assert.deepEqual(briefAllowed(gate({ lastActiveAt: new Date(NOW.getTime() - ACTIVE_WITHIN_MS) })), { ok: true });
});

test('the brief is claimed once a day; a quiet day or a closed gate does not claim it', async () => {
  const store = createMemoryNoticeStore();
  const rest = {
    name: 'Du',
    matters: [matter('a')],
    events: [],
    unsorted: [],
    couldNotCheck: [],
    checked: { mail: 0, byRules: 0, byModel: 0 },
  };
  assert.deepEqual(await runBrief(store, gate({ enabled: false }), rest), { sent: false, reason: 'off' });
  assert.deepEqual(await runBrief(store, gate(), { ...rest, matters: [] }), { sent: false, reason: 'nothing_to_say' });
  const first = await runBrief(store, gate(), rest);
  assert.equal(first.sent, true);
  assert.equal(first.sent && first.brief.needsYou.length, 1);
  assert.deepEqual(await runBrief(store, gate({ now: new Date('2026-11-24T18:00:00Z') }), rest), { sent: false, reason: 'already_sent' });
  assert.equal((await runBrief(store, gate({ now: new Date('2026-11-25T08:00:00Z'), lastActiveAt: NOW }), rest)).sent, true);
});

test('after the brief, held matters count as told and keep their earlier told time', async () => {
  const store = createMemoryNoticeStore();
  await store.putMatter(matter('held', { pendingDelivery: 'daily_cap' }));
  await store.putMatter(matter('told', { notifiedAt: '2026-11-23T09:00:00.000Z' }));
  const brief = buildBrief(input({ matters: await store.listMatters() }));
  brief.needsYou.push({ matterKey: 'ghost', title: '', summary: '', pending: false, suspect: false });
  brief.keptQuiet.push({ matterKey: 'ghost-quiet', title: '', summary: '', pending: true, suspect: false });
  await markBriefed(store, brief, NOW);
  assert.deepEqual(
    [(await store.getMatter('held'))?.notifiedAt, (await store.getMatter('held'))?.pendingDelivery],
    [NOW.toISOString(), undefined],
  );
  assert.equal((await store.getMatter('told'))?.notifiedAt, '2026-11-23T09:00:00.000Z');
  assert.equal(await store.getMatter('ghost'), undefined);
  assert.equal(await store.getMatter('ghost-quiet'), undefined);
});

test('the brief day and its claim follow the home zone, whatever zone the calling device is in', async () => {
  const claims: string[] = [];
  const store = { ...createMemoryNoticeStore(), claimBrief: async (day: string) => (claims.push(day), true) };
  const at = new Date('2026-11-24T20:00:00Z');
  const rest = {
    name: null,
    matters: [matter('a')],
    events: [],
    unsorted: [],
    couldNotCheck: [],
    checked: { mail: 0, byRules: 0, byModel: 0 },
  };
  for (const device of ['Asia/Tokyo', 'America/Los_Angeles']) {
    const saved = process.env.TZ;
    process.env.TZ = device;
    try {
      await runBrief(
        store,
        { enabled: true, now: at, settings: noticeSettings('Asia/Shanghai', { quietHours: null }), lastActiveAt: at },
        rest,
      );
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  }
  assert.deepEqual(claims, ['2026-11-25', '2026-11-25']);
});

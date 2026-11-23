// MoMo notice limits (shared/momoNotice/limits.ts, memoryStore.ts): quiet hours, the daily cap, once per matter, snooze, track, dismiss, due checks, and the catch-up test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLimits,
  dismissMatter,
  dueMatters,
  inQuietHours,
  isCatchUp,
  isMaterialChange,
  localTime,
  noticeSettings,
  resolveMatter,
  snoozeMatter,
  sweepMatters,
  zonedMidnight,
  type LimitInput,
  type NoticeSettings,
} from '../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore } from '../shared/momoNotice/memoryStore.ts';
import type { Matter, ReadingAnswer, Verdict } from '../shared/momoNotice/types.d.ts';

const at = (iso: string) => new Date(iso);
const UTC = noticeSettings('UTC');
const input = (verdict: Verdict, over: Partial<LimitInput> & { key?: string } = {}): LimitInput => ({
  answer: { verdict, reason: 'Because.', matterKey: over.key ?? 'k1' } as ReadingAnswer,
  matterKey: over.key ?? 'k1',
  title: 'Subject',
  source: { sourceId: 'gmail', id: over.key ?? 'k1', version: 'v1' },
  ...over,
});
const run = (store: ReturnType<typeof createMemoryNoticeStore>, now: string, i: LimitInput, settings: NoticeSettings = UTC) =>
  applyLimits(store, settings, at(now), i);
const NOON = '2026-11-24T12:00:00Z';

test('local time follows the time zone, including the day', () => {
  assert.deepEqual(localTime(at('2026-11-24T23:30:00Z'), 'UTC'), { dayKey: '2026-11-24', minute: 23 * 60 + 30 });
  assert.deepEqual(localTime(at('2026-11-24T23:30:00Z'), 'Asia/Shanghai'), { dayKey: '2026-11-25', minute: 7 * 60 + 30 });
  assert.deepEqual(localTime(at('2026-11-24T00:05:00Z'), 'UTC'), { dayKey: '2026-11-24', minute: 5 });
});

test('quiet hours run 22:00 to 08:00 by default, wrap midnight, and can be a same-day window or off', () => {
  const q = (iso: string, settings: NoticeSettings = UTC) => inQuietHours(settings, at(iso));
  assert.equal(q('2026-11-24T22:00:00Z'), true);
  assert.equal(q('2026-11-24T21:59:00Z'), false);
  assert.equal(q('2026-11-24T03:00:00Z'), true);
  assert.equal(q('2026-11-24T07:59:00Z'), true);
  assert.equal(q('2026-11-24T08:00:00Z'), false);
  assert.equal(q('2026-11-24T15:00:00Z', noticeSettings('Asia/Shanghai')), true);
  const day = { ...UTC, quietHours: { startMinute: 600, endMinute: 660 } };
  assert.equal(q('2026-11-24T10:30:00Z', day), true);
  assert.equal(q('2026-11-24T11:00:00Z', day), false);
  assert.equal(q('2026-11-24T23:00:00Z', { ...UTC, quietHours: null }), false);
});

test('a sleep is a gap longer than the setting, never on the first pass', () => {
  assert.equal(isCatchUp(undefined, at(NOON), UTC), false);
  assert.equal(isCatchUp(at('2026-11-24T11:00:00Z'), at(NOON), UTC), false);
  assert.equal(isCatchUp(at('2026-11-24T09:59:00Z'), at(NOON), UTC), true);
});

test('a quiet answer creates nothing and never renames, refreshes or silences a matter', async () => {
  const store = createMemoryNoticeStore();
  assert.deepEqual(await run(store, NOON, input('quiet')), { action: 'quiet', matterKey: 'k1' });
  assert.deepEqual(await store.listMatters(), []);
  await run(store, NOON, input('track'));
  const before = await store.getMatter('k1');
  await run(store, '2026-11-24T13:00:00Z', input('quiet', { title: "Another mail's subject" }));
  assert.deepEqual(await store.getMatter('k1'), before);
});

test('an existing matter keeps its title when another item joins it', async () => {
  const store = createMemoryNoticeStore();
  await run(store, NOON, input('track', { title: 'First' }));
  await run(store, NOON, input('track', { title: 'Second', source: { sourceId: 'gmail', id: 'other', version: 'v' } }));
  assert.equal((await store.getMatter('k1'))?.title, 'First');
});

test('track makes a watching entry with a next check a day later, kept past a snooze', async () => {
  const store = createMemoryNoticeStore();
  assert.deepEqual(await run(store, NOON, input('track')), { action: 'watch', matterKey: 'k1', nextCheck: '2026-11-25T12:00:00.000Z' });
  const matter = await store.getMatter('k1');
  assert.equal(matter?.state, 'watching');
  assert.equal(matter?.nextCheck, '2026-11-25T12:00:00.000Z');
  await snoozeMatter(store, 'k1', at('2026-11-27T00:00:00Z'), at(NOON));
  assert.equal((await run(store, NOON, input('track'))).action, 'watch');
  assert.equal((await store.getMatter('k1'))?.nextCheck, '2026-11-27T00:00:00.000Z');
});

test('a tell-now outside quiet hours is delivered once and counted', async () => {
  const store = createMemoryNoticeStore();
  assert.deepEqual(await run(store, NOON, input('tell_now', { deadline: '2026-11-26T00:00:00Z' })), {
    action: 'tell_now',
    matterKey: 'k1',
  });
  const matter = await store.getMatter('k1');
  assert.deepEqual(
    [matter?.state, matter?.notifiedAt, matter?.notifiedDeadline, matter?.sources.length],
    ['open', '2026-11-24T12:00:00.000Z', '2026-11-26T00:00:00Z', 1],
  );
});

test('a tell-now in quiet hours waits for the brief and is not counted', async () => {
  const store = createMemoryNoticeStore();
  assert.deepEqual(await run(store, '2026-11-24T23:00:00Z', input('tell_now')), { action: 'hold', matterKey: 'k1', why: 'quiet_hours' });
  const matter = await store.getMatter('k1');
  assert.deepEqual([matter?.pendingDelivery, matter?.notifiedAt], ['quiet_hours', undefined]);
  assert.equal(await store.tryCountTold('2026-11-24', 1), true);
});

test('the seventh tell-now of a local day is held for the brief; the next day counts afresh', async () => {
  const store = createMemoryNoticeStore();
  for (let n = 1; n <= 6; n += 1) assert.equal((await run(store, NOON, input('tell_now', { key: `k${n}` }))).action, 'tell_now');
  assert.deepEqual(await run(store, NOON, input('tell_now', { key: 'k7' })), { action: 'hold', matterKey: 'k7', why: 'daily_cap' });
  assert.equal((await store.getMatter('k7'))?.pendingDelivery, 'daily_cap');
  assert.equal((await run(store, '2026-11-25T12:00:00Z', input('tell_now', { key: 'k8' }))).action, 'tell_now');
  // a held matter is told when the next pass finds room
  assert.equal((await run(store, '2026-11-25T13:00:00Z', input('tell_now', { key: 'k7' }))).action, 'tell_now');
  assert.equal((await store.getMatter('k7'))?.pendingDelivery, undefined);
});

test('the cap is the setting, and a catch-up delivery does not use it', async () => {
  const store = createMemoryNoticeStore();
  const one = { ...UTC, dailyCap: 1 };
  assert.equal((await run(store, NOON, input('tell_now', { key: 'a', mode: 'catch_up' }), one)).action, 'catch_up');
  assert.equal((await run(store, NOON, input('tell_now', { key: 'b' }), one)).action, 'tell_now');
  assert.equal((await run(store, NOON, input('tell_now', { key: 'c' }), one)).action, 'hold');
  assert.equal((await store.getMatter('a'))?.notifiedAt, '2026-11-24T12:00:00.000Z');
});

test('catch-up in quiet hours still waits for the brief', async () => {
  const store = createMemoryNoticeStore();
  assert.equal((await run(store, '2026-11-24T23:00:00Z', input('tell_now', { mode: 'catch_up' }))).action, 'hold');
});

test('one nudge per matter, unless the situation gets an earlier deadline', async () => {
  const store = createMemoryNoticeStore();
  await run(store, NOON, input('tell_now', { deadline: '2026-11-26T00:00:00Z' }));
  assert.deepEqual(await run(store, '2026-11-24T13:00:00Z', input('tell_now')), { action: 'hold', matterKey: 'k1', why: 'already_told' });
  assert.equal((await run(store, '2026-11-24T13:00:00Z', input('tell_now', { deadline: '2026-11-27T00:00:00Z' }))).action, 'hold');
  assert.equal((await run(store, '2026-11-24T13:00:00Z', input('tell_now', { deadline: '2026-11-25T00:00:00Z' }))).action, 'tell_now');
  assert.equal((await store.getMatter('k1'))?.notifiedDeadline, '2026-11-25T00:00:00Z');
  // a deadline where none was told is new information
  await run(store, NOON, input('tell_now', { key: 'nd' }));
  assert.equal(
    (await run(store, '2026-11-24T13:00:00Z', input('tell_now', { key: 'nd', deadline: '2026-11-25T00:00:00Z' }))).action,
    'tell_now',
  );
});

test('a watching or resolved matter that turns urgent is reopened and told', async () => {
  const store = createMemoryNoticeStore();
  await run(store, NOON, input('track'));
  assert.equal((await run(store, '2026-11-24T13:00:00Z', input('tell_now'))).action, 'tell_now');
  const matter = await store.getMatter('k1');
  assert.deepEqual([matter?.state, matter?.nextCheck], ['open', undefined]);
  await store.putMatter({ ...(matter as NonNullable<typeof matter>), state: 'resolved', notifiedAt: undefined });
  assert.equal((await run(store, '2026-11-24T14:00:00Z', input('tell_now', { key: 'k1' }))).action, 'tell_now');
  assert.equal((await store.getMatter('k1'))?.state, 'open');
  // a held tell-now on a watching matter reopens it too
  await run(store, NOON, input('track', { key: 'w' }));
  assert.equal((await run(store, '2026-11-24T23:30:00Z', input('tell_now', { key: 'w' }))).action, 'hold');
  assert.equal((await store.getMatter('w'))?.state, 'open');
});

test('a snooze holds the matter until it ends, then allows one more tell-now', async () => {
  const store = createMemoryNoticeStore();
  assert.equal(await snoozeMatter(store, 'missing', at(NOON), at(NOON)), false);
  await run(store, NOON, input('tell_now'));
  assert.equal(await snoozeMatter(store, 'k1', at('2026-11-24T15:00:00Z'), at('2026-11-24T12:30:00Z')), true);
  assert.deepEqual(await run(store, '2026-11-24T13:00:00Z', input('tell_now')), { action: 'hold', matterKey: 'k1', why: 'snoozed' });
  assert.equal((await store.getMatter('k1'))?.pendingDelivery, 'snoozed');
  assert.equal((await run(store, '2026-11-24T16:00:00Z', input('tell_now'))).action, 'tell_now');
  assert.equal((await store.getMatter('k1'))?.snoozedUntil, undefined);
  assert.equal((await run(store, '2026-11-24T17:00:00Z', input('tell_now'))).action, 'hold');
});

test('snoozing a matter that was never told leaves it free to be told after the snooze', async () => {
  const store = createMemoryNoticeStore();
  await run(store, '2026-11-24T23:00:00Z', input('tell_now'));
  await snoozeMatter(store, 'k1', at('2026-11-25T09:00:00Z'), at('2026-11-24T23:10:00Z'));
  assert.equal((await store.getMatter('k1'))?.pendingDelivery, undefined);
  assert.equal((await run(store, '2026-11-25T10:00:00Z', input('tell_now'))).action, 'tell_now');
});

test('a dismissed matter raises nothing again', async () => {
  const store = createMemoryNoticeStore();
  assert.equal(await dismissMatter(store, 'k1', at(NOON)), false);
  await run(store, NOON, input('track'));
  assert.equal(await dismissMatter(store, 'k1', at(NOON)), true);
  const matter = await store.getMatter('k1');
  assert.deepEqual([matter?.state, matter?.nextCheck, matter?.pendingDelivery], ['dismissed', undefined, undefined]);
  for (const verdict of ['tell_now', 'track', 'quiet'] as const)
    assert.deepEqual(await run(store, '2026-11-25T12:00:00Z', input(verdict)), { action: 'hold', matterKey: 'k1', why: 'dismissed' });
});

test('a matter keeps its six newest sources, one per item', async () => {
  const store = createMemoryNoticeStore();
  for (let n = 1; n <= 8; n += 1) await run(store, NOON, input('track', { source: { sourceId: 'gmail', id: `m${n}`, version: 'v' } }));
  await run(store, NOON, input('track', { source: { sourceId: 'gmail', id: 'm8', version: 'v2' } }));
  const sources = (await store.getMatter('k1'))?.sources.map((s) => `${s.id}:${s.version}`);
  assert.deepEqual(sources, ['m3:v', 'm4:v', 'm5:v', 'm6:v', 'm7:v', 'm8:v2']);
});

test('due matters are watching, past their next check and not snoozed', async () => {
  const store = createMemoryNoticeStore();
  await run(store, NOON, input('track', { key: 'due' }));
  await run(store, NOON, input('track', { key: 'snoozed' }));
  await snoozeMatter(store, 'snoozed', at('2026-11-30T00:00:00Z'), at(NOON));
  await run(store, NOON, input('tell_now', { key: 'open' }));
  assert.deepEqual(await dueMatters(store, at('2026-11-25T11:59:00Z')), []);
  assert.deepEqual(
    (await dueMatters(store, at('2026-11-25T12:00:00Z'))).map((m) => m.matterKey),
    ['due'],
  );
  const raw = await store.getMatter('snoozed');
  await store.putMatter({ ...(raw as NonNullable<typeof raw>), snoozedUntil: '2026-11-24T00:00:00Z', nextCheck: '2026-11-25T12:00:00Z' });
  assert.deepEqual((await dueMatters(store, at('2026-11-25T12:00:00Z'))).map((m) => m.matterKey).sort(), ['due', 'snoozed']);
  await store.putMatter({ matterKey: 'nocheck', state: 'watching', title: 't', summary: 's', sources: [], updatedAt: NOON });
  assert.equal(
    (await dueMatters(store, at('2026-11-25T12:00:00Z'))).some((m) => m.matterKey === 'nocheck'),
    false,
  );
});

test('the memory store claims a brief once a day and counts per day', async () => {
  const store = createMemoryNoticeStore();
  assert.equal(await store.claimBrief('2026-11-24'), true);
  assert.equal(await store.claimBrief('2026-11-24'), false);
  assert.equal(await store.claimBrief('2026-11-25'), true);
  assert.equal(await store.tryCountTold('d', 1), true);
  assert.equal(await store.tryCountTold('d', 1), false);
  assert.equal(await store.getMatter('none'), undefined);
});

test('a material change is a more urgent situation or a nearer deadline, not a continued thread', () => {
  const told: Matter = {
    matterKey: 'k',
    state: 'open',
    title: 't',
    summary: 's',
    sources: [],
    updatedAt: NOON,
    notifiedAt: NOON,
    notifiedUrgency: 2,
    notifiedDeadline: '2026-11-27',
  };
  const change = (over: Partial<LimitInput>) => isMaterialChange(told, { ...input('tell_now'), ...over });
  assert.equal(change({}), false);
  assert.equal(change({ urgency: 2, deadline: '2026-11-27' }), false);
  assert.equal(change({ urgency: 1, deadline: '2026-11-30' }), false);
  assert.equal(change({ urgency: 3 }), true);
  assert.equal(change({ deadline: '2026-11-25' }), true);
  const plain = { ...told, notifiedUrgency: undefined, notifiedDeadline: undefined };
  assert.equal(isMaterialChange(plain, { ...input('tell_now'), deadline: '2026-11-25' }), true);
  assert.equal(isMaterialChange(plain, { ...input('tell_now'), urgency: 2 }), true);
});

test('a told matter is told once more for a final notice, and not for a trivial follow-up', async () => {
  const store = createMemoryNoticeStore();
  await run(store, NOON, input('tell_now', { urgency: 2, deadline: '2026-11-27' }));
  assert.equal((await run(store, '2026-11-24T13:00:00Z', input('tell_now', { urgency: 2, deadline: '2026-11-27' }))).action, 'hold');
  assert.equal((await run(store, '2026-11-24T14:00:00Z', input('tell_now', { urgency: 3, deadline: '2026-11-24' }))).action, 'tell_now');
  const matter = await store.getMatter('k1');
  assert.deepEqual([matter?.notifiedUrgency, matter?.notifiedDeadline], [3, '2026-11-24']);
  assert.equal((await run(store, '2026-11-24T15:00:00Z', input('tell_now', { urgency: 3, deadline: '2026-11-24' }))).action, 'hold');
  // a later deadline never replaces a nearer one that was told
  await run(store, NOON, input('tell_now', { key: 'n', urgency: 3, deadline: '2026-11-24' }));
  await run(store, '2026-11-24T13:00:00Z', input('tell_now', { key: 'n', urgency: 3, deadline: '2026-11-26' }));
  assert.equal((await store.getMatter('n'))?.notifiedDeadline, '2026-11-24');
});

test('on the first connect nothing is pushed: tell-nows wait for the brief, tracks still watch', async () => {
  const store = createMemoryNoticeStore();
  assert.deepEqual(await run(store, NOON, input('tell_now', { mode: 'first_connect' })), {
    action: 'hold',
    matterKey: 'k1',
    why: 'first_connect',
  });
  const matter = await store.getMatter('k1');
  assert.deepEqual([matter?.pendingDelivery, matter?.notifiedAt], ['first_connect', undefined]);
  assert.equal((await run(store, NOON, input('track', { key: 't', mode: 'first_connect' }))).action, 'watch');
  assert.equal(await store.tryCountTold('2026-11-24', 1), true);
});

test('the cap counts one delivery per source version, so a retry does not count twice', async () => {
  const store = createMemoryNoticeStore();
  assert.equal(await store.tryCountTold('d', 1, 'a'), true);
  assert.equal(await store.tryCountTold('d', 1, 'a'), true);
  assert.equal(await store.tryCountTold('d', 1, 'b'), false);
  assert.equal(await store.tryCountTold('d', 2), true);
  assert.equal(await store.tryCountTold('d', 2), false);
});

test('a day starts at the home zone midnight, across zones and daylight saving', () => {
  assert.equal(zonedMidnight('2026-11-25', 'Asia/Shanghai').toISOString(), '2026-11-24T16:00:00.000Z');
  assert.equal(zonedMidnight('2026-11-24', 'America/Los_Angeles').toISOString(), '2026-11-24T08:00:00.000Z');
  assert.equal(zonedMidnight('2026-03-08', 'America/Los_Angeles').toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(zonedMidnight('2026-11-24', 'UTC').toISOString(), '2026-11-24T00:00:00.000Z');
});

test('two devices in different zones agree on the cap day because the home zone decides it', async () => {
  const store = createMemoryNoticeStore();
  const home = noticeSettings('Asia/Tokyo', { dailyCap: 1, quietHours: null });
  // 15:30 UTC is already the next day in Tokyo: one local day, whichever device calls
  assert.equal((await run(store, '2026-11-24T14:30:00Z', input('tell_now', { key: 'a' }), home)).action, 'tell_now');
  assert.equal((await run(store, '2026-11-24T14:50:00Z', input('tell_now', { key: 'b' }), home)).action, 'hold');
  assert.equal((await run(store, '2026-11-24T15:10:00Z', input('tell_now', { key: 'c' }), home)).action, 'tell_now');
});

test('a resolved matter can be reopened and a matter ends by itself when its event passed or it went stale', async () => {
  const store = createMemoryNoticeStore();
  assert.equal(await resolveMatter(store, 'k1', at(NOON)), false);
  await run(store, NOON, input('track', { key: 'stale' }));
  await run(store, NOON, input('tell_now', { key: 'event', expiresAt: '2026-11-24T15:00:00Z' }));
  await run(store, '2026-11-01T12:00:00Z', input('track', { key: 'old' }));
  await run(store, NOON, input('tell_now', { key: 'fresh' }));
  assert.deepEqual((await sweepMatters(store, at('2026-11-24T16:00:00Z'))).sort(), ['event', 'old']);
  assert.deepEqual(await sweepMatters(store, at('2026-11-24T16:00:00Z')), []);
  assert.deepEqual((await sweepMatters(store, at('2026-12-20T00:00:00Z'), 1000)).sort(), ['fresh', 'stale']);
  assert.equal((await store.getMatter('event'))?.state, 'resolved');
  await dismissMatter(store, 'fresh', at(NOON));
  assert.equal(await resolveMatter(store, 'fresh', at(NOON)), false);
  assert.equal((await run(store, '2026-12-21T12:00:00Z', input('tell_now', { key: 'event' }))).action, 'tell_now');
  assert.equal((await store.getMatter('event'))?.state, 'open');
});

test('the default settings are the design’s, on the home zone', () => {
  assert.deepEqual(noticeSettings('UTC', { dailyCap: 3 }), {
    timeZone: 'UTC',
    quietHours: { startMinute: 1320, endMinute: 480 },
    dailyCap: 3,
    trackRecheckMs: 86_400_000,
    catchUpGapMs: 7_200_000,
  });
});

test('a quiet window whose start equals its end is no window, not the whole day', () => {
  const same = noticeSettings('UTC', { quietHours: { startMinute: 600, endMinute: 600 } });
  for (const hour of ['00:00', '10:00', '15:30']) assert.equal(inQuietHours(same, at(`2026-11-24T${hour}:00Z`)), false);
});

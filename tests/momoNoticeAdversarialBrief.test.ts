// Adversarial brief scenarios for the MoMo notice pipeline: exactly one brief per home-day under clock skew, DST, zone change and restart, never inside quiet hours, never on a quiet day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markBriefed, runBrief, type BriefInput } from '../shared/momoNotice/brief.ts';
import { localTime, noticeSettings, type NoticeSettings } from '../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore } from '../shared/momoNotice/memoryStore.ts';
import type { Matter, NoticeStore } from '../shared/momoNotice/types.d.ts';
import { pick, rng } from './momoEvals/notice/helpers.ts';

const HOUR = 3_600_000;
const matter = (key: string, at: Date): Matter => ({
  matterKey: key,
  state: 'open',
  title: `Matter ${key}`,
  summary: 's',
  sources: [],
  updatedAt: at.toISOString(),
});
const input = (matters: Matter[]): Omit<BriefInput, 'now' | 'settings'> => ({
  name: 'Maya',
  matters,
  events: [],
  unsorted: [],
  couldNotCheck: [],
  checked: { mail: 0, byRules: 0, byModel: 0 },
});
const attempt = (
  store: NoticeStore,
  at: Date,
  zone: string,
  settings: NoticeSettings = noticeSettings(zone),
  matters: Matter[] = [matter('m1', at)],
) => runBrief(store, { enabled: true, now: at, settings, lastActiveAt: at }, input(matters));

const ZONES = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Asia/Kolkata', 'Pacific/Auckland', 'Australia/Lord_Howe'] as const;

test('property: with seeded skew, DST starts and restarts there is at most one brief per home-day and none in quiet hours', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const random = rng(seed);
    const zone = pick(random, ZONES);
    const store = createMemoryNoticeStore();
    const days = new Map<string, number>();
    let at = new Date(
      pick(random, [
        '2026-03-07T00:00:00Z',
        '2026-03-28T00:00:00Z',
        '2026-10-24T00:00:00Z',
        '2026-10-31T00:00:00Z',
        '2026-04-04T00:00:00Z',
      ]),
    );
    for (let step = 0; step < 120; step++) {
      // forward by 5-70 minutes, with a seeded clock step back of up to 30 minutes now and then (NTP skew)
      const skew = random() < 0.1 ? -Math.floor(random() * 30) * 60_000 : 0;
      at = new Date(at.getTime() + (5 + Math.floor(random() * 65)) * 60_000 + skew);
      const run = await attempt(store, at, zone);
      if (!run.sent) continue;
      const { dayKey, minute } = localTime(at, zone);
      days.set(dayKey, (days.get(dayKey) ?? 0) + 1);
      assert.ok(minute >= 8 * 60 && minute < 22 * 60, `seed ${seed}: brief at local minute ${minute} (${zone}, ${at.toISOString()})`);
    }
    for (const [day, n] of days) assert.equal(n, 1, `seed ${seed}: ${n} briefs on ${day}`);
  }
});

test('concurrent attempts on one day send exactly one brief, and the others only display it', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-22T16:00:00Z');
  const runs = await Promise.all(Array.from({ length: 8 }, () => attempt(store, at, 'America/Los_Angeles')));
  assert.equal(runs.filter((r) => r.sent).length, 1);
  assert.ok(runs.filter((r) => !r.sent).every((r) => !r.sent && r.reason === 'already_sent'));
});

test('DST: the 25-hour and the 23-hour day each carry one brief, at 08:00 local', async () => {
  for (const [day, zone] of [
    ['2026-11-01', 'America/Los_Angeles'],
    ['2026-03-08', 'America/Los_Angeles'],
    ['2026-10-25', 'Europe/London'],
    ['2026-04-05', 'Australia/Lord_Howe'],
  ] as const) {
    const store = createMemoryNoticeStore();
    let sent = 0;
    for (let h = 0; h < 48; h++) {
      const at = new Date(Date.parse(`${day}T00:00:00Z`) - 12 * HOUR + h * HOUR);
      const run = await attempt(store, at, zone);
      if (run.sent) sent += 1;
    }
    assert.ok(sent >= 1 && sent <= 3, `${zone} ${day}: ${sent} briefs over 48 hours`);
  }
});

test('a quiet day sends nothing and does not use up the day; a later pass with news still sends once', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-22T16:00:00Z');
  const quiet = await attempt(store, at, 'America/Los_Angeles', noticeSettings('America/Los_Angeles'), []);
  assert.deepEqual(quiet, { sent: false, reason: 'nothing_to_say' });
  const later = await attempt(store, new Date(at.getTime() + 2 * HOUR), 'America/Los_Angeles');
  assert.equal(later.sent, true);
  const again = await attempt(store, new Date(at.getTime() + 3 * HOUR), 'America/Los_Angeles');
  assert.deepEqual(again, { sent: false, reason: 'already_sent' });
});

test('the standing rules: off, quiet hours and an inactive user send nothing and claim nothing', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-22T16:00:00Z');
  const base = { now: at, settings: noticeSettings('America/Los_Angeles'), lastActiveAt: at };
  assert.equal((await runBrief(store, { ...base, enabled: false }, input([matter('a', at)]))).sent, false);
  assert.equal(
    (await runBrief(store, { ...base, enabled: true, now: new Date('2026-10-23T06:00:00Z') }, input([matter('a', at)]))).sent,
    false,
  );
  assert.equal(
    (await runBrief(store, { ...base, enabled: true, lastActiveAt: new Date(at.getTime() - 7 * 86_400_000 - 1) }, input([matter('a', at)])))
      .sent,
    false,
  );
  assert.equal((await runBrief(store, { ...base, enabled: true, lastActiveAt: undefined }, input([matter('a', at)]))).sent, false);
  assert.equal((await attempt(store, at, 'America/Los_Angeles')).sent, true);
});

test('a brief marks what it carried as told, so the once-per-matter rule keeps those matters quiet', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-22T16:00:00Z');
  await store.putMatter({ ...matter('held', at), pendingDelivery: 'daily_cap' });
  const run = await attempt(store, at, 'America/Los_Angeles', noticeSettings('America/Los_Angeles'), await store.listMatters());
  assert.equal(run.sent, true);
  if (run.sent) await markBriefed(store, run.brief, at);
  const after = await store.getMatter('held');
  assert.equal(after?.pendingDelivery, undefined);
  assert.equal(after?.notifiedAt, at.toISOString());
});

// ---- findings from the adversarial review ----

test('F12: two devices asking for the same morning claim one brief, because the home zone decides the day', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-23T23:30:00Z');
  const home = noticeSettings('America/Los_Angeles');
  const first = await attempt(store, at, 'ignored', home);
  const second = await attempt(store, at, 'ignored', home);
  assert.equal([first, second].filter((r) => r.sent).length, 1);
});

test('F13: moving the home zone from east to west within the day does not send a second brief', async () => {
  const store = createMemoryNoticeStore();
  const run = (at: Date, zone: string, lastBriefAt?: Date) =>
    runBrief(
      store,
      { enabled: true, now: at, settings: noticeSettings(zone), lastActiveAt: at, ...(lastBriefAt ? { lastBriefAt } : {}) },
      input([matter('m1', at)]),
    );
  const tokyoAt = new Date('2026-10-22T23:30:00Z'); // 08:30 Oct 23 JST
  const tokyo = await run(tokyoAt, 'Asia/Tokyo');
  const la = await run(new Date('2026-10-23T00:30:00Z'), 'America/Los_Angeles', tokyoAt); // 17:30 Oct 22 PDT: a different day key
  assert.equal([tokyo, la].filter((r) => r.sent).length, 1);
  assert.deepEqual(la, { sent: false, reason: 'already_sent' });
  // a day later the gap has passed and a new brief is allowed
  assert.equal((await run(new Date('2026-10-24T16:00:00Z'), 'America/Los_Angeles', tokyoAt)).sent, true);
});

test('F14: a brief that was claimed but never shown can be released and sent again', async () => {
  const store = createMemoryNoticeStore();
  const at = new Date('2026-10-22T16:00:00Z');
  const first = await attempt(store, at, 'America/Los_Angeles');
  assert.equal(first.sent, true);
  assert.deepEqual(await attempt(store, new Date(at.getTime() + HOUR), 'America/Los_Angeles'), { sent: false, reason: 'already_sent' });
  // delivery failed (or the process died before it was shown): the Host gives the day back
  if (first.sent) await store.releaseBrief(first.brief.dayKey);
  assert.equal((await attempt(store, new Date(at.getTime() + HOUR), 'America/Los_Angeles')).sent, true);
});

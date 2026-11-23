// Adversarial limit scenarios for the MoMo notice pipeline: seeded random days against the cap, quiet hours and once-per-matter rules, plus first connect, catch-up, snooze, DST, two zones and matter poisoning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissMatter, inQuietHours, localTime, noticeSettings, snoozeMatter } from '../shared/momoNotice/limits.ts';
import { count, mailFor, matterOf, modelFor, newHome, pass, pick, rng } from './momoEvals/notice/helpers.ts';

const ZONES = [
  'America/Los_Angeles',
  'Asia/Tokyo',
  'UTC',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
] as const;
const HOUR = 3_600_000;
const LA = noticeSettings('America/Los_Angeles');

test('property: over seeded random days the cap, quiet hours and once-per-matter hold in every zone', async () => {
  for (let seed = 1; seed <= 120; seed++) {
    const random = rng(seed);
    const zone = pick(random, ZONES);
    const home = newHome();
    // a start day near a DST change in some zone
    let at = new Date(
      pick(random, [
        '2026-03-07T00:00:00Z',
        '2026-03-28T00:00:00Z',
        '2026-10-31T00:00:00Z',
        '2026-11-01T00:00:00Z',
        '2026-04-04T00:00:00Z',
      ]),
    );
    const toldPerDay = new Map<string, number>();
    const toldMatters = new Map<string, number>();
    let thread = 0;
    let lastRunAt: Date | undefined;
    for (let step = 0; step < 40; step++) {
      at = new Date(at.getTime() + Math.floor(random() * 90) * 60_000 + 60_000); // gaps stay under the catch-up gap
      const ids = Array.from(
        { length: Math.floor(random() * 4) },
        () => `th-${seed}-${random() < 0.3 && thread > 0 ? Math.floor(random() * thread) : thread++}`,
      );
      const unique = [...new Set(ids)];
      const result = await pass(home, unique, at, { timeZone: zone, ...(lastRunAt ? { lastRunAt } : {}) });
      lastRunAt = at;
      for (const d of result.decisions) {
        if (d.outcome !== 'tell_now') continue;
        const { dayKey } = localTime(at, zone);
        toldPerDay.set(dayKey, (toldPerDay.get(dayKey) ?? 0) + 1);
        toldMatters.set(d.matterKey, (toldMatters.get(d.matterKey) ?? 0) + 1);
        assert.equal(inQuietHours(noticeSettings(zone), at), false, `seed ${seed}: tell_now in quiet hours at ${at.toISOString()} ${zone}`);
      }
    }
    for (const [day, n] of toldPerDay) assert.ok(n <= LA.dailyCap, `seed ${seed}: ${n} tell-nows on ${day}`);
    for (const [matter, n] of toldMatters) assert.equal(n, 1, `seed ${seed}: ${matter} told ${n} times`);
  }
});

test('the cap holds when passes run at the same time (atomic count)', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => pass(home, [`c${i}a`, `c${i}b`, `c${i}c`], at)));
  assert.equal(
    results.reduce((n, r) => n + count(r.decisions, 'tell_now'), 0),
    LA.dailyCap,
  );
});

test('the cap and once-per-matter survive a restart (new deps, same store)', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  const first = await pass(home, ['r1', 'r2', 'r3', 'r4'], at);
  const second = await pass(home, ['r1', 'r5', 'r6', 'r7', 'r8'], new Date(at.getTime() + HOUR), { lastRunAt: at });
  assert.equal(count(first.decisions, 'tell_now') + count(second.decisions, 'tell_now'), LA.dailyCap);
  assert.equal(second.decisions[0]?.heldFor, 'already_told');
});

test('quiet hours hold across midnight in the home zone, and release at the boundary minute', async () => {
  const zone = 'America/Los_Angeles';
  const home = newHome();
  const held = await pass(home, ['q1'], new Date('2026-10-23T14:59:00Z'), { timeZone: zone }); // 07:59 PDT
  assert.equal(held.decisions[0]?.heldFor, 'quiet_hours');
  const open = await pass(home, ['q2'], new Date('2026-10-23T15:00:00Z'), { timeZone: zone }); // 08:00 PDT
  assert.equal(open.decisions[0]?.outcome, 'tell_now');
  const late = await pass(home, ['q3'], new Date('2026-10-23T04:59:00Z'), { timeZone: zone }); // 21:59 PDT
  assert.equal(late.decisions[0]?.outcome, 'tell_now');
  const night = await pass(home, ['q4'], new Date('2026-10-23T05:00:00Z'), { timeZone: zone }); // 22:00 PDT
  assert.equal(night.decisions[0]?.heldFor, 'quiet_hours');
});

test('quiet hours follow the zone through the DST changes (fall back and spring forward)', () => {
  const zone = 'America/Los_Angeles';
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-11-01T15:59:00Z')), true); // 07:59 PST on the 25-hour day
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-11-01T16:00:00Z')), false); // 08:00 PST
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-11-01T08:30:00Z')), true); // 01:30 PDT then again 01:30 PST
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-11-01T09:30:00Z')), true);
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-03-08T14:59:00Z')), true); // 07:59 PDT on the 23-hour day
  assert.equal(inQuietHours(noticeSettings(zone), new Date('2026-03-08T15:00:00Z')), false);
  for (const z of ZONES)
    assert.ok(localTime(new Date('2026-03-08T07:00:00Z'), z).minute >= 0 && localTime(new Date('2026-03-08T07:00:00Z'), z).minute < 1440);
  assert.equal(localTime(new Date('2026-10-22T07:00:00Z'), 'UTC').minute, 420);
  assert.equal(localTime(new Date('2026-10-22T00:00:00Z'), 'UTC').minute, 0);
  assert.equal(localTime(new Date('2026-10-22T18:30:00Z'), 'Asia/Kathmandu').dayKey, '2026-10-23');
});

test('no quiet hours means none', async () => {
  const none = await pass(newHome(), ['n1'], new Date('2026-10-22T09:00:00Z'), { settings: noticeSettings('UTC', { quietHours: null }) });
  assert.equal(none.decisions[0]?.outcome, 'tell_now');
});

test('F11: an equal start and end turns quiet hours into all day', async () => {
  const at = new Date('2026-10-22T09:00:00Z');
  const equal = await pass(newHome(), ['n2'], at, {
    settings: noticeSettings('UTC', { quietHours: { startMinute: 600, endMinute: 600 } }),
  });
  assert.equal(equal.decisions[0]?.outcome, 'tell_now', 'start == end is an empty window, or must be rejected when saved');
});

test('catch-up after sleep: one summary, nothing individually pushed, the cap untouched', async () => {
  const home = newHome();
  const slept = new Date('2026-10-22T18:00:00Z');
  const ids = Array.from({ length: 9 }, (_, i) => `u${i}`);
  const result = await pass(home, ids, slept, { lastRunAt: new Date(slept.getTime() - 5 * HOUR) });
  assert.equal(count(result.decisions, 'tell_now'), 0);
  assert.equal(result.catchUp?.count, 9);
  const after = await pass(home, ['u-next'], new Date(slept.getTime() + HOUR), { lastRunAt: slept });
  assert.equal(after.decisions[0]?.outcome, 'tell_now');
  // exactly at the gap is not a sleep
  const edge = await pass(newHome(), ['edge'], slept, { lastRunAt: new Date(slept.getTime() - LA.catchUpGapMs) });
  assert.equal(edge.decisions[0]?.outcome, 'tell_now');
});

test('a clock that jumps backwards is not read as a sleep and never delivers the same matter twice', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  await pass(home, ['b1'], at);
  const back = await pass(home, ['b1', 'b2'], new Date(at.getTime() - 3 * HOUR), { lastRunAt: at });
  assert.equal(back.catchUp, undefined);
  assert.equal(back.decisions[0]?.heldFor, 'already_told');
});

test('snooze: held while snoozed, delivered once after, never before; dismissed stays dismissed', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  await pass(home, ['s1'], at);
  assert.equal(await snoozeMatter(home.store, matterOf('s1'), new Date(at.getTime() + 4 * HOUR), at), true);
  const during = await pass(home, ['s1'], new Date(at.getTime() + HOUR), { lastRunAt: at });
  assert.equal(during.decisions[0]?.heldFor, 'snoozed');
  const after = await pass(home, ['s1'], new Date(at.getTime() + 5 * HOUR), { lastRunAt: new Date(at.getTime() + 4 * HOUR) });
  assert.equal(after.decisions[0]?.outcome, 'tell_now');
  const again = await pass(home, ['s1'], new Date(at.getTime() + 6 * HOUR), { lastRunAt: new Date(at.getTime() + 5 * HOUR) });
  assert.equal(again.decisions[0]?.heldFor, 'already_told');
  assert.equal(await snoozeMatter(home.store, 'nope', at, at), false);
  await dismissMatter(home.store, matterOf('s1'), at);
  await snoozeMatter(home.store, matterOf('s1'), new Date(at.getTime() - HOUR), at);
  const dismissed = await pass(home, ['s1'], new Date(at.getTime() + 9 * HOUR), { lastRunAt: new Date(at.getTime() + 8 * HOUR) });
  assert.equal(dismissed.decisions[0]?.heldFor, 'dismissed');
});

test('a failed reading is unsorted, not marked seen, and read again by the next pass', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  const broken = { name: 'broken', complete: async () => 'not json' };
  const first = await pass(home, ['w1'], at, { model: broken });
  assert.equal(first.decisions[0]?.outcome, 'unsorted');
  const second = await pass(home, ['w1'], new Date(at.getTime() + HOUR), { lastRunAt: at });
  assert.equal(second.decisions[0]?.outcome, 'tell_now');
});

test('a mail whose subject or body tries to name another thread cannot move its matter', async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  await pass(home, ['victim'], at);
  const result = await pass(home, ['attacker'], new Date(at.getTime() + HOUR), {
    lastRunAt: at,
    model: modelFor({ attacker: { verdict: 'tell_now', matterKey: 'gmail:no-such-matter' } }),
  });
  assert.equal(result.decisions[0]?.matterKey, 'gmail:attacker');
});

// ---- findings: each is a minimal reproduction that fails on current code (visible as a todo, not red) ----

test('F8: first connect reads weeks of old mail and pushes the first six as if they were new', async () => {
  const home = newHome();
  const now = new Date('2026-10-22T18:00:00Z');
  const ids = Array.from({ length: 10 }, (_, i) => `old${i}`);
  const mails = Object.fromEntries(ids.map((id, i) => [id, { date: new Date(now.getTime() - (3 + i) * 86_400_000).toISOString() }]));
  const result = await pass(home, ids, now, { mails, firstConnect: true });
  assert.equal(count(result.decisions, 'tell_now'), 0, 'old mail from a first connect must not become pushes');
});

test('F9: two callers with different zones double the cap for the same instant', async () => {
  const home = newHome();
  const at = new Date('2026-10-23T01:00:00Z'); // 18:00 on Oct 22 in Los Angeles, 10:00 on Oct 23 in Tokyo
  const a = await pass(
    home,
    Array.from({ length: 6 }, (_, i) => `za${i}`),
    at,
    { settings: noticeSettings('Asia/Tokyo') },
  );
  const b = await pass(
    home,
    Array.from({ length: 6 }, (_, i) => `zb${i}`),
    at,
    { settings: noticeSettings('Asia/Tokyo') },
  );
  assert.ok(count(a.decisions, 'tell_now') + count(b.decisions, 'tell_now') <= LA.dailyCap);
});

test("F10: a quiet answer naming another live matter overwrites that matter's title and summary", async () => {
  const home = newHome();
  const at = new Date('2026-10-22T18:00:00Z');
  await pass(home, ['victim'], at, { mails: { victim: { subject: 'Approve the quote of $4,200' } } });
  const before = await home.store.getMatter(matterOf('victim'));
  await pass(home, ['evil'], new Date(at.getTime() + HOUR), {
    lastRunAt: at,
    mails: { evil: { subject: 'Nothing to see here' } },
    model: modelFor({ evil: { verdict: 'quiet', matterKey: matterOf('victim') } }),
  });
  const after = await home.store.getMatter(matterOf('victim'));
  assert.equal(after?.title, before?.title);
  assert.equal(after?.summary, before?.summary);
});

test('mail dated in the future or the far past does not crash the limits', async () => {
  const home = newHome();
  const result = await pass(home, ['fut', 'past'], new Date('2026-10-22T18:00:00Z'), {
    mails: { fut: { date: '2999-01-01T00:00:00Z' }, past: { date: '1970-01-01T00:00:00Z' } },
  });
  assert.equal(result.decisions.length, 2);
  assert.equal(mailFor('x').threadId, 'x');
});

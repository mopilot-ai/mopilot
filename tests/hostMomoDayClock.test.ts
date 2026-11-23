// MoMo's day on its home, the clock edges (host/src/momoDaily.mjs, momoClock.mjs, momoPrefs.mjs): daylight saving, a change of time zone, a clock that steps, the settings and their defaults, and a brief time that quiet hours would swallow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { dailySettingsOf, noticeSettingsOf } from '../host/src/momoDaily.mjs';
// @ts-ignore
import { clockMinutes, hostZone, inQuiet, minuteInQuiet, nextWallTime, quietEndsAt, zonedParts } from '../host/src/momoClock.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { createMomoPrefs } from '../host/src/momoPrefs.mjs';

import { MIN, NY, wall, world } from './support/host/momoDayWorld.ts';

test('daylight saving: a brief time that does not exist that day goes at the next real minute, and one that happens twice goes once', async () => {
  // 2026-03-08, New York: 2:00 jumps to 3:00
  const spring = world({ start: wall(NY, '2026-03-08', '01:00') });
  spring.state.settings = { ...spring.state.settings, time: '02:30', quiet: null };
  await spring.daily.tick();
  assert.deepEqual(await spring.walk(wall(NY, '2026-03-08', '03:00')), ['brief:delivered']);
  spring.advance(30_000);
  assert.deepEqual((await spring.daily.tick()).did, []);

  // 2026-11-01: 1:30 happens twice
  const fall = world({ start: wall(NY, '2026-11-01', '00:30') });
  fall.state.settings = { ...fall.state.settings, time: '01:30', quiet: null };
  await fall.walk(wall(NY, '2026-11-01', '01:30'));
  assert.equal(fall.calls.deliver.length, 1);
  await fall.walk(fall.now() + 60 * MIN);
  assert.equal(zonedParts(fall.now(), NY).minutes, 90, 'the same wall time again');
  assert.equal(fall.calls.deliver.length, 1, 'the second 1:30 is the same day');
});

test('a change of time zone moves the day and the time with it but never gives two briefs within 18 hours', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  await w.daily.tick();
  assert.equal(w.calls.deliver.length, 1);
  // the owner flies to Tokyo: 8:00 there on the 24th is 18:00 on the 23rd in New York, ten hours later
  w.state.settings = { ...w.state.settings, zone: 'Asia/Tokyo' };
  assert.deepEqual(
    (await w.walk(wall('Asia/Tokyo', '2026-11-24', '08:00'))).filter((x: string) => x.startsWith('brief')),
    [],
  );
  assert.equal(w.calls.deliver.length, 1);
  // the day after, at 8:00 in Tokyo, it goes
  assert.deepEqual(
    (await w.walk(wall('Asia/Tokyo', '2026-11-25', '08:00'))).filter((x: string) => x.startsWith('brief')),
    ['brief:delivered'],
  );
  // an unknown zone reads on this Host's own clock
  const u = world({ start: wall(NY, '2026-11-23', '08:00') });
  u.state.settings = { ...u.state.settings, zone: 'Mars/Olympus' };
  assert.equal(zonedParts(u.now(), 'Mars/Olympus').zone, hostZone());
});

test('clock skew: a clock that steps back or forward after the brief gives no second brief, and a step back is saved', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '07:55') });
  await w.walk(wall(NY, '2026-11-23', '08:00'));
  // a device whose clock is a day ahead, or the Host's clock corrected two hours back, changes nothing: the claim is on the home's own record of the day
  w.set(wall(NY, '2026-11-23', '06:00'));
  await w.daily.tick();
  await w.walk(wall(NY, '2026-11-23', '08:05'));
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.catchUp.length, 0, 'a step back is not a sleep');
});

test('dailySettingsOf: off until turned on, 8:00 and 22:00-08:00 by default, quiet hours as the owner set them, none when equal or null', () => {
  const d = dailySettingsOf(undefined);
  assert.equal(d.on, false);
  assert.equal(d.time, '08:00');
  assert.deepEqual(d.quiet, { start: 1320, end: 480 });
  assert.equal(d.zone, hostZone());
  const s = dailySettingsOf({
    momo: { paused: true, brief: { on: true, time: '07:30', zone: NY }, routines: { quietHours: { start: '23:00', end: '06:30' } } },
  });
  assert.deepEqual([s.on, s.paused, s.time, s.zone, s.quiet], [true, true, '07:30', NY, { start: 1380, end: 390 }]);
  assert.equal(dailySettingsOf({ momo: { routines: { quietHours: null } } }).quiet, null);
  assert.equal(dailySettingsOf({ momo: { routines: { quietHours: { start: '08:00', end: '08:00' } } } }).quiet, null);
  assert.deepEqual(dailySettingsOf({ momo: { routines: { quietHours: { start: 'x', end: '08:00' } } } }).quiet, { start: 1320, end: 480 });
  assert.equal(dailySettingsOf({ momo: { brief: { time: '25:00' } } }).time, '08:00');
});

test('the clock helpers: minutes of a clock, quiet hours across midnight, and the end of quiet hours across daylight saving', () => {
  assert.equal(clockMinutes('7:05'), 425);
  assert.equal(clockMinutes('24:00'), null);
  assert.equal(clockMinutes(5), null);
  const night = { start: 22 * 60, end: 8 * 60 };
  assert.equal(minuteInQuiet(night, 23 * 60), true);
  assert.equal(minuteInQuiet(night, 60), true);
  assert.equal(minuteInQuiet(night, 12 * 60), false);
  assert.equal(minuteInQuiet({ start: 60, end: 120 }, 90), true);
  assert.equal(minuteInQuiet(null, 90), false);
  assert.equal(minuteInQuiet({ start: 5, end: 5 }, 5), false);
  assert.equal(inQuiet(night, wall(NY, '2026-11-23', '23:00'), NY), true);
  assert.equal(quietEndsAt(night, wall(NY, '2026-11-23', '12:00'), NY), null);
  assert.equal(quietEndsAt(night, wall(NY, '2026-11-23', '23:00'), NY), wall(NY, '2026-11-24', '08:00'));
  // the night of 2026-11-01 is an hour longer, of 2026-03-08 an hour shorter: both end at 8:00 on the wall
  assert.equal(quietEndsAt(night, wall(NY, '2026-10-31', '23:00'), NY), wall(NY, '2026-11-01', '08:00'));
  assert.equal(quietEndsAt(night, wall(NY, '2026-03-07', '23:00'), NY), wall(NY, '2026-03-08', '08:00'));
  // a window that never ends inside a day and a hour is bounded
  assert.ok(typeof quietEndsAt({ start: 0, end: 1 }, wall(NY, '2026-11-23', '00:00'), NY) === 'number');
});

test('the notice core settings come from the home: its names, quiet hours as minutes, the owner’s cap, none when quiet hours are off', () => {
  assert.deepEqual(noticeSettingsOf(undefined), {
    timeZone: hostZone(),
    quietHours: { startMinute: 1320, endMinute: 480 },
    dailyCap: 6,
    trackRecheckMs: 86_400_000,
    catchUpGapMs: 7_200_000,
  });
  const s = noticeSettingsOf({ momo: { routines: { quietHours: null }, notify: { tellNowMax: 3 }, brief: { zone: 'Asia/Tokyo' } } });
  assert.equal(s.timeZone, 'Asia/Tokyo');
  assert.deepEqual([s.quietHours, s.dailyCap], [null, 3]);
});

test('a brief time inside quiet hours is refused when it is set, with the cause; one outside is accepted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-prefs-'));
  const prefs = createMomoPrefs({ home: { storage: { dir }, data: { safeStorage: createFileSafeStorage(dir) } } });
  await assert.rejects(prefs.change({ brief: { on: true, time: '23:30' } }), /inside quiet hours/);
  assert.equal(prefs.get().brief.on, false, 'nothing was saved');
  assert.equal((await prefs.change({ brief: { on: true, time: '09:00' } })).brief.time, '09:00');
  // moving quiet hours over the brief time is refused too
  await assert.rejects(prefs.change({ quietHours: { start: '22:00', end: '10:00' } }), /inside quiet hours/);
  assert.equal((await prefs.change({ quietHours: null })).brief.on, true);
});

test('the day’s, the push’s, the scheduler’s and the taint’s files are MoMo’s own: a move’s bundle carries every one (so a new home cannot send a second brief that day or forget what it must not remember from), and the Host’s own files stay', async () => {
  const { stays } = await import('../host/src/momoMove.mjs');
  const { collectFiles } = await import('../host/src/momoBundle.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-bundle-'));
  for (const f of [
    'daily.json',
    'push.json',
    'ticks.json',
    'taint.json',
    'prefs.json',
    'grant.json',
    'home.json',
    'chats.json',
    'stamps.json',
    'x.lock',
  ])
    fs.writeFileSync(path.join(dir, f), '{}');
  const carried = collectFiles(dir, stays).map((f: { path: string }) => f.path);
  assert.deepEqual(carried, ['daily.json', 'prefs.json', 'push.json', 'taint.json', 'ticks.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a search that finds nothing within a day and an hour stops there: a window that never ends, a wall time that does not exist', () => {
  const t = wall(NY, '2026-11-23', '12:00');
  // quiet from midnight to the end of the day never ends
  const end = quietEndsAt({ start: 0, end: 1440 }, t, NY);
  assert.ok(end && end > t + 24 * 60 * MIN);
  // no minute of a day reads 2000
  const next = nextWallTime(2000, t, NY);
  assert.ok(next > t + 25 * 60 * MIN);
});

test('the brief settings keep their zone, and a notify patch changes only what it names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-prefs-'));
  const prefs = createMomoPrefs({ home: { storage: { dir }, data: { safeStorage: createFileSafeStorage(dir) } } });
  assert.equal((await prefs.change({ brief: { zone: 'Asia/Tokyo' } })).brief.zone, 'Asia/Tokyo');
  assert.deepEqual((await prefs.change({ notify: { previews: true } })).notify, { previews: true, tellNowMax: 6 });
  assert.deepEqual((await prefs.change({ notify: { tellNowMax: 3 } })).notify, { previews: true, tellNowMax: 3 });
  assert.equal(prefs.forRoutines().momo.brief.zone, 'Asia/Tokyo');
});

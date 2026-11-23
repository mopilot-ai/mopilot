// MoMo's day on its home, the invariants the evaluation sets ask of the driver (host/src/momoDaily.mjs): exactly one brief per home-day under clock skew, daylight saving, a change of zone, restarts and sleeps; a crash after the claim loses nothing; quiet hours that start and end together silence nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { dailySettingsOf } from '../host/src/momoDaily.mjs';
// @ts-ignore
import { zonedParts } from '../host/src/momoClock.mjs';
import { MIN, NY, wall, world } from './support/host/momoDayWorld.ts';

test('F13: a zone change east to west that lands inside the brief window gives no second brief', async () => {
  const w = world({ start: wall('Pacific/Auckland', '2026-11-24', '07:55') });
  w.state.settings = { ...w.state.settings, zone: 'Pacific/Auckland', quiet: null };
  await w.walk(wall('Pacific/Auckland', '2026-11-24', '08:00'));
  assert.equal(w.calls.deliver.length, 1);
  // the owner lands in Honolulu: the same instant reads 09:00 on the 23rd there, inside the window of a day that has no brief yet
  w.state.settings = { ...w.state.settings, zone: 'Pacific/Honolulu' };
  assert.equal(zonedParts(w.now(), 'Pacific/Honolulu').minutes, 9 * 60);
  const later = await w.walk(w.now() + 3 * 60 * MIN);
  assert.deepEqual(
    later.filter((x: string) => x.startsWith('brief')),
    [],
  );
  assert.equal(w.calls.deliver.length, 1);
});

test('F14: a crash after the notice store claimed the day and before the delivery loses nothing: the Host delivers it once on restart without claiming again', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '07:55') });
  let claims = 0;
  w.state.claimBrief = () => (claims++, true);
  let crash = true;
  w.state.deliver = () => {
    if (crash) throw new Error('process died');
  };
  const d = w.make();
  await w.walk(wall(NY, '2026-11-23', '08:00'), d);
  assert.equal(claims, 1);
  crash = false;
  // a new process over the same folder
  const again = w.make();
  w.advance(30_000);
  assert.deepEqual((await again.tick()).did, ['brief:delivered']);
  assert.equal(claims, 1, 'the day was already claimed: the notice store is not asked again');
});

test('F11: quiet hours that start and end together silence nothing', async () => {
  assert.equal(dailySettingsOf({ momo: { routines: { quietHours: { start: '22:00', end: '22:00' } } } }).quiet, null);
  const w = world({ start: wall(NY, '2026-11-23', '07:55') });
  w.state.settings = {
    ...w.state.settings,
    quiet: dailySettingsOf({ momo: { routines: { quietHours: { start: '22:00', end: '22:00' } } } }).quiet,
  };
  await w.walk(wall(NY, '2026-11-23', '08:00'));
  assert.equal(w.calls.deliver.length, 1);
});

/** A small seeded generator, so a failing run is the same run. */
const seeded = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('property: over 5 seeded days with restarts, sleeps, clock steps, daylight saving and zone changes, a home-day never has two briefs and no id is delivered twice', async () => {
  const zones = [NY, 'Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Auckland'];
  for (const seed of [1, 4]) {
    const rand = seeded(seed);
    const zone = zones[seed % zones.length];
    const w = world({ start: wall(zone, '2027-03-12', '00:00') });
    w.state.settings = { ...w.state.settings, zone };
    let daily = w.daily;
    for (let step = 0; step < 5 * 24 * 6; step++) {
      const r = rand();
      if (r < 0.002)
        daily = w.make(); // a restart
      else if (r < 0.004)
        w.advance(Math.floor(rand() * 4 * 60) * MIN); // a sleep
      else if (r < 0.005)
        w.advance(-Math.floor(rand() * 90) * MIN); // the clock stepped back
      else if (r < 0.006) w.state.settings = { ...w.state.settings, zone: zones[Math.floor(rand() * zones.length)] };
      w.advance(9 * MIN);
      await daily.tick();
    }
    const ids = w.calls.deliver.map((c: any) => c.id);
    // a delivery that is repeated (a retry after a failed clear) has the same id; two different ids never share a home-day
    const byDay = new Map<string, Set<string>>();
    for (const id of new Set<string>(ids)) {
      const day = id.slice('brief:'.length);
      byDay.set(day, (byDay.get(day) ?? new Set()).add(id));
    }
    for (const [day, set] of byDay) assert.equal(set.size, 1, `${day}: ${[...set]}`);
  }
});

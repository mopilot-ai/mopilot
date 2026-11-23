// MoMo's day on its home (host/src/momoDaily.mjs): the brief claimed once, a restart in the middle of one, duplicate delivery, catch-up after a sleep, the 3:00 tidy, the lease fence, and the zone, daylight saving and clock-skew edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoDaily, MAX_TRIES, SLEEP_GAP_MS } from '../host/src/momoDaily.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';

import { MIN, NY, wall, world } from './support/host/momoDayWorld.ts';

test('the brief goes once at the user time, worded by one model pass, and a second tick or a second device adds nothing', async () => {
  const w = world();
  assert.deepEqual((await w.daily.tick()).did, [], 'before the time nothing is sent');
  assert.deepEqual(await w.walk(wall(NY, '2026-11-23', '08:00')), ['brief:delivered']);
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.deliver[0].text, 'worded plain brief 2026-11-23');
  assert.equal(w.calls.deliver[0].id, 'brief:2026-11-23');
  assert.equal(w.calls.deliver[0].stamp.leaseEpoch, 1, 'the delivery carries the lease epoch');
  assert.equal(w.calls.word.length, 1);
  w.advance(30_000);
  assert.deepEqual((await w.daily.tick()).did, []);
  // a second object over the same data dir (another process, a restart) sees the claim
  assert.deepEqual((await w.make().tick()).did, []);
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.daily.status().today, 'delivered');
});

test('two ticks racing for the same day deliver once, on one home and across two that share the day claim', async () => {
  // one home: the single flight per day
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  await Promise.all([w.daily.tick(), w.daily.tick()]);
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.build.length, 1);
  // two Hosts (each its own record) are made once-only by the notice store's atomic claim, which is the only thing they share
  const taken = new Set<string>();
  const claim = (a: any) => (taken.has(a.day) ? false : (taken.add(a.day), true));
  const [x, y] = [world({ start: wall(NY, '2026-11-23', '08:00') }), world({ start: wall(NY, '2026-11-23', '08:00') })];
  x.state.claimBrief = claim;
  y.state.claimBrief = claim;
  await Promise.all([x.make().tick(), y.make().tick()]);
  assert.equal(x.calls.deliver.length + y.calls.deliver.length, 1);
});

test('a quiet day sends nothing; a wording failure sends the plain brief; an empty wording keeps the plain brief', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  w.state.build = () => null;
  assert.deepEqual((await w.daily.tick()).did, ['brief:quiet']);
  assert.equal(w.calls.deliver.length, 0);
  assert.equal(w.daily.status().today, 'quiet');

  const x = world({ start: wall(NY, '2026-11-23', '08:00') });
  x.state.word = () => {
    throw new Error('model down');
  };
  await x.daily.tick();
  assert.equal(x.calls.deliver[0].text, 'plain brief 2026-11-23');
  assert.match(x.reports.join('\n'), /wording failed/);

  const y = world({ start: wall(NY, '2026-11-23', '08:00') });
  y.state.word = () => '   ';
  await y.daily.tick();
  assert.equal(y.calls.deliver[0].text, 'plain brief 2026-11-23');
});

test('off, paused, quiet hours, an inactive person, a missing builder and the 18-hour gap each keep the brief back', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  w.state.settings = { ...w.state.settings, on: false };
  assert.equal((await w.daily.tick()).idle, 'off');
  w.state.settings = { ...w.state.settings, on: true, paused: true };
  assert.equal((await w.daily.tick()).idle, 'off');
  assert.equal(w.daily.status().on, false);
  // brief time inside quiet hours: it waits for their end
  w.state.settings = { ...w.state.settings, paused: false, time: '08:00', quiet: { start: 22 * 60, end: 9 * 60 } };
  assert.deepEqual((await w.daily.tick()).did, []);
  assert.deepEqual(await w.walk(wall(NY, '2026-11-23', '09:00')), ['brief:delivered']);

  const idle = world({ start: wall(NY, '2026-11-23', '08:00') });
  idle.state.active = () => false;
  const quietly = createMomoDaily({
    home: {
      stamp: () => ({ homeId: 'h', leaseEpoch: 1 }),
      current: () => true,
      receiveStamp: () => ({ ok: true }),
      storage: { dir: idle.dir },
      data: { safeStorage: createFileSafeStorage(idle.dir) },
    },
    settings: () => idle.state.settings,
    now: idle.now,
    report: () => undefined,
    seams: { build: () => ({ text: 'x' }), deliver: () => undefined, active: () => false },
  });
  assert.deepEqual((await quietly.tick()).did, []);
  assert.equal(await quietly.briefNow().then((r: string) => r), 'delivered', 'show it now ignores the person being away');

  const bare = createMomoDaily({
    home: {
      stamp: () => ({ homeId: 'h', leaseEpoch: 1 }),
      current: () => true,
      receiveStamp: () => ({ ok: true }),
      storage: { dir: idle.dir },
      data: { safeStorage: createFileSafeStorage(idle.dir) },
    },
    settings: () => idle.state.settings,
    now: idle.now,
    report: () => undefined,
  });
  assert.deepEqual((await bare.tick()).did, []);
  assert.equal(await bare.briefNow(), 'unavailable');
});

test('a Host that comes up after the brief window sends no late brief', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '12:00') });
  assert.deepEqual((await w.daily.tick()).did, []);
  assert.equal(w.calls.build.length, 0);
});

test('a restart in the middle of a brief delivers the same text under the same id and builds nothing twice; too many failures call it failed', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  let boom = true;
  w.state.deliver = () => {
    if (boom) throw new Error('chat is busy');
  };
  assert.deepEqual((await w.daily.tick()).did, ['brief:ready']);
  assert.equal(w.daily.status().today, 'ready');
  boom = false;
  w.advance(30_000);
  // the process died: a new object, the same folder
  const again = w.make();
  assert.deepEqual((await again.tick()).did, ['brief:delivered']);
  assert.equal(w.calls.build.length, 1, 'built once');
  assert.equal(w.calls.word.length, 1, 'worded once');
  assert.equal(w.calls.deliver.length, 2);
  assert.equal(w.calls.deliver[0].id, w.calls.deliver[1].id);
  assert.equal(w.calls.deliver[0].text, w.calls.deliver[1].text);

  const f = world({ start: wall(NY, '2026-11-23', '08:00') });
  f.state.deliver = () => {
    throw new Error('never');
  };
  for (let i = 0; i < MAX_TRIES; i++) {
    await f.daily.tick();
    f.advance(30_000);
  }
  const s = f.daily.status();
  assert.equal(s.today, 'failed');
  assert.deepEqual(s.failure, { code: 'brief_failed', fix: 'show_brief_now' });
  // "Show it now" starts over, and a delivered brief is left alone
  f.state.deliver = () => undefined;
  assert.equal(await f.daily.briefNow(), 'delivered');
  assert.equal(await f.daily.briefNow(), 'already');
  assert.equal(f.daily.status().failure, null);
});

test('a brief claimed but not yet built is built after a restart', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  let first = true;
  w.state.build = (a: any) => {
    if (first) {
      first = false;
      throw new Error('builder crashed');
    }
    return { text: `plain brief ${a.day}` };
  };
  assert.deepEqual((await w.daily.tick()).did, ['brief:claimed']);
  w.advance(30_000);
  assert.deepEqual((await w.make().tick()).did, ['brief:delivered']);
  assert.equal(w.calls.deliver.length, 1);
});

test('the notice store claim is taken after the Host claim, and a brief it refuses is not delivered', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  w.state.claimBrief = () => false;
  const d = w.make();
  assert.deepEqual((await d.tick()).did, []);
  assert.equal(w.calls.claim.length, 1);
  assert.equal(w.calls.deliver.length, 0);
  assert.equal(d.status().today, 'elsewhere');
  const ok = world({ start: wall(NY, '2026-11-23', '08:00') });
  ok.state.claimBrief = () => true;
  assert.deepEqual((await ok.make().tick()).did, ['brief:delivered']);
});

test('a stale lease epoch is refused before and after the build; a Host that is not the home does nothing', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  w.setCurrent(false);
  assert.deepEqual((await w.daily.tick()).did, ['brief:refused']);
  assert.equal(w.calls.build.length, 0);
  assert.match(w.reports.join('\n'), /home has moved on/);

  // the lease moves between the build and the delivery
  const x = world({ start: wall(NY, '2026-11-23', '08:00') });
  x.state.build = (a: any) => {
    x.setCurrent(false);
    return { text: `plain brief ${a.day}` };
  };
  assert.deepEqual((await x.daily.tick()).did, ['brief:refused']);
  assert.equal(x.calls.deliver.length, 0);
  assert.equal(x.daily.status().today, 'ready', 'what was built is kept');

  x.setLease(null);
  assert.deepEqual(await x.daily.tick(), { idle: 'not-home', did: [] });
  assert.equal(await x.daily.briefNow(), 'not-home');
});

test('a catch-up after the home slept is one card and is not repeated; a restart reads as a sleep', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '13:12') });
  await w.daily.tick();
  w.set(wall(NY, '2026-11-23', '15:40'));
  assert.deepEqual((await w.daily.tick()).did, ['catchUp']);
  assert.equal(w.calls.catchUp.length, 1);
  assert.equal(w.calls.catchUp[0].from, wall(NY, '2026-11-23', '13:12'));
  assert.equal(w.calls.catchUp[0].to, w.now());
  assert.equal(w.calls.catchUp[0].stamp.leaseEpoch, 1);
  w.advance(30_000);
  assert.deepEqual((await w.daily.tick()).did, []);
  assert.equal(w.calls.catchUp.length, 1);
  assert.ok(SLEEP_GAP_MS > 30_000);

  // restart: a new object finds the last awake time on disk
  w.advance(2 * 60 * MIN);
  assert.deepEqual((await w.make().tick()).did, ['catchUp']);
});

test('a catch-up that fails is tried again; one that falls in quiet hours waits for their end; the brief replaces a catch-up that waited', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '13:00') });
  await w.daily.tick();
  w.set(wall(NY, '2026-11-23', '15:00'));
  w.state.catchUp = () => {
    throw new Error('chat busy');
  };
  assert.deepEqual((await w.daily.tick()).did, []);
  assert.match(w.reports.join('\n'), /catch-up could not be delivered/);
  w.state.catchUp = () => undefined;
  w.advance(30_000);
  assert.deepEqual((await w.daily.tick()).did, ['catchUp']);

  // slept from 21:00 to 23:30: quiet, so the card waits; at 8:00 the brief goes and nothing else
  const n = world({ start: wall(NY, '2026-11-23', '21:00') });
  await n.daily.tick();
  n.set(wall(NY, '2026-11-23', '23:30'));
  assert.deepEqual((await n.daily.tick()).did, []);
  assert.equal(n.daily.status().pendingCatchUp, true);
  n.set(wall(NY, '2026-11-24', '07:50'));
  assert.deepEqual((await n.daily.tick()).did, []);
  n.set(wall(NY, '2026-11-24', '08:00'));
  assert.deepEqual((await n.daily.tick()).did, ['brief:delivered']);
  assert.equal(n.calls.catchUp.length, 0);
  assert.equal(n.daily.status().pendingCatchUp, false);
});

test('a home asleep through the brief time gets one catch-up card and a missed brief that "Show it now" can still make', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '07:30') });
  await w.daily.tick();
  w.set(wall(NY, '2026-11-23', '09:10'));
  assert.deepEqual((await w.daily.tick()).did, ['brief:missed', 'catchUp']);
  assert.equal(w.calls.deliver.length, 0);
  assert.deepEqual(w.daily.status().failure, { code: 'brief_missed_asleep', fix: 'show_brief_now' });
  assert.equal(await w.daily.briefNow(), 'delivered');
  assert.equal(w.daily.status().failure, null);
});

test('the 3:00 tidy runs once a night, only when something changed, and a failing tidy is reported and not repeated', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '02:59') });
  await w.daily.tick();
  w.set(wall(NY, '2026-11-23', '03:00'));
  assert.deepEqual((await w.daily.tick()).did, [], 'nothing changed: not run');
  w.state.changed = true;
  w.advance(MIN);
  assert.deepEqual((await w.daily.tick()).did, [], 'the night is already looked at');
  w.set(wall(NY, '2026-11-24', '03:00'));
  assert.deepEqual(
    (await w.daily.tick()).did.filter((x: string) => x === 'tidy'),
    ['tidy'],
  );
  assert.equal(w.calls.tidy.length, 1);
  assert.equal(w.calls.tidy[0].stamp.leaseEpoch, 1);
  w.advance(MIN);
  await w.daily.tick();
  assert.equal(w.calls.tidy.length, 1);

  const f = world({ start: wall(NY, '2026-11-23', '03:00') });
  f.state.changed = true;
  f.state.tidyRun = () => {
    throw new Error('disk full');
  };
  assert.deepEqual((await f.daily.tick()).did, []);
  assert.match(f.reports.join('\n'), /notes tidy failed/);
  // outside the hour nothing is looked at
  const late = world({ start: wall(NY, '2026-11-23', '04:30') });
  late.state.changed = true;
  await late.daily.tick();
  assert.equal(late.calls.tidy.length, 0);
  // a stale lease does not tidy
  const stale = world({ start: wall(NY, '2026-11-23', '03:00') });
  stale.state.changed = true;
  stale.state.tidyChanged = () => {
    stale.setCurrent(false);
    return true;
  };
  await stale.daily.tick();
  assert.equal(stale.calls.tidy.length, 0);
});

test('"Show it now" never blocks tomorrow’s brief, and a double tap or a tick that claimed the day first builds the brief once', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '18:30') });
  assert.equal(await w.daily.briefNow(), 'delivered');
  // the 18-hour gap is for scheduled briefs: tomorrow at 8:00 is 13.5 hours later and still goes
  assert.deepEqual(await w.walk(wall(NY, '2026-11-24', '08:00')).then((d: string[]) => d.filter((x) => x.startsWith('brief'))), [
    'brief:delivered',
  ]);
  assert.equal(w.calls.deliver.length, 2);

  const d = world({ start: wall(NY, '2026-11-23', '09:00') });
  let gate: () => void = () => undefined;
  d.state.build = async (a: any) => {
    await new Promise<void>((r) => (gate = r));
    return { text: `plain brief ${a.day}` };
  };
  const first = d.daily.briefNow();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await d.daily.briefNow(), 'busy', 'the day is being built: a second tap builds nothing');
  gate();
  assert.equal(await first, 'delivered');
  assert.equal(d.calls.build.length, 1);
});

test('a claim the notice store could not answer leaves the day free for the next tick', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  let fail = true;
  w.state.claimBrief = () => {
    if (fail) throw new Error('store busy');
    return true;
  };
  const d = w.make();
  assert.deepEqual((await d.tick()).did, []);
  assert.match(w.reports.join(), /could not be claimed/);
  assert.equal(d.status().today, null);
  fail = false;
  w.advance(30_000);
  assert.deepEqual((await d.tick()).did, ['brief:delivered']);
});

test('a catch-up has an id: one that was delivered is not delivered again after a crash, one that keeps failing is given up, and the id reaches the seam', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '13:00') });
  await w.daily.tick();
  w.set(wall(NY, '2026-11-23', '15:00'));
  assert.deepEqual((await w.daily.tick()).did, ['catchUp']);
  assert.equal(w.calls.catchUp[0].id, `catchup:${wall(NY, '2026-11-23', '13:00')}`);
  const f = world({ start: wall(NY, '2026-11-23', '13:00') });
  await f.daily.tick();
  f.set(wall(NY, '2026-11-23', '15:00'));
  f.state.catchUp = () => {
    throw new Error('chat busy');
  };
  for (let i = 0; i < 6; i++) {
    await f.daily.tick();
    f.advance(30_000);
  }
  assert.equal(f.calls.catchUp.length, 5, 'tried five times, then given up');
  assert.equal(f.daily.status().pendingCatchUp, false);
});

test('a brief begun under a lease that a newer one has since replaced, or whose newest lease cannot be kept (the home’s stamp sink says no), is not delivered', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  w.setStale(true);
  assert.deepEqual((await w.daily.tick()).did, ['brief:refused']);
  assert.equal(w.calls.deliver.length, 0);
  w.setStale(false);
  w.advance(30_000);
  assert.deepEqual((await w.daily.tick()).did, ['brief:delivered']);
});

test('a day record that cannot be read is reported and nothing is done on it', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  // a folder where the record belongs cannot be read as one
  fs.mkdirSync(path.join(w.dir, 'daily.json'));
  assert.deepEqual(await w.daily.tick(), { idle: 'unreadable', did: [] });
  assert.match(w.reports.join(), /day record could not be read/);
  assert.equal(w.daily.status().today, null);
});

test('the notice lane gives its parts after the day is made: setSeams, then the next tick delivers', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  const bare = createMomoDaily({
    home: {
      stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }),
      current: () => true,
      receiveStamp: () => ({ ok: true }),
      storage: { dir: w.dir },
      data: { safeStorage: createFileSafeStorage(w.dir) },
    },
    settings: () => w.state.settings,
    now: w.now,
    report: () => undefined,
  });
  assert.deepEqual((await bare.tick()).did, [], 'no builder yet: nothing is done');
  const delivered: string[] = [];
  bare.setSeams({ build: () => ({ text: 'plain' }), deliver: (a: any) => void delivered.push(a.text) });
  w.advance(30_000);
  assert.deepEqual((await bare.tick()).did, ['brief:delivered']);
  assert.deepEqual(delivered, ['plain']);
});

test('"Show it now" from two places at once builds the day once: the second finds the day claimed', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '18:00') });
  const other = w.make();
  const [a, b] = await Promise.all([w.daily.briefNow(), other.briefNow()]);
  assert.deepEqual([a, b].sort(), ['busy', 'delivered']);
  assert.equal(w.calls.build.length, 1);
});

test('"Show it now" picks up a brief a failed delivery left half done, and says failed while it still fails', async () => {
  const w = world({ start: wall(NY, '2026-11-23', '08:00') });
  let fail = true;
  w.state.deliver = () => {
    if (fail) throw new Error('chat is busy');
  };
  assert.deepEqual((await w.daily.tick()).did, ['brief:ready']);
  assert.equal(await w.daily.briefNow(), 'failed', 'the same text, tried again, still not delivered');
  assert.equal(w.calls.build.length, 1, 'built once');
  fail = false;
  assert.equal(await w.daily.briefNow(), 'delivered');
  assert.equal(w.calls.build.length, 1);
});

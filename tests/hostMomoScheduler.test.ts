// MoMo's scheduler on a Host, H3a (host/src/momoScheduler.mjs over electron/momo/seams.cjs): ticks only while the home has stores, each run's start is on disk before the run, a restart never runs a due time again and reads a cut-off run as Didn't finish, a skipped time is not a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoScheduler } from '../host/src/momoScheduler.mjs';
// @ts-ignore
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { waitFor } from './support/waitFor.ts';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { RunSkipped } = require('../electron/platform/scheduler.cjs');

/** A clock the test moves by hand; `after` timers fire when it is advanced past them. */
function manualClock(start = 1_700_000_000_000) {
  let at = start;
  const timers = new Set<{ due: number; fn: () => void }>();
  return {
    now: () => at,
    after: (fn: () => void, ms: number) => {
      const timer = { due: at + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number) {
      at += ms;
      for (const t of [...timers]) if (t.due <= at && timers.delete(t)) t.fn();
    },
    pending: () => timers.size,
  };
}
/** A rule that is a period in milliseconds ("60000" is every minute), so the tests name their due times. */
const rules = {
  nextRun: (rule: string, after: Date) =>
    rule === 'never' ? null : new Date(Math.floor(after.getTime() / Number(rule) + 1) * Number(rule)),
};
const task = (id: string, extra: object = {}) => ({ id, rrule: '60000', status: 'ACTIVE', ...extra });
/** Wait for a condition on the real clock: the ledger's writes take real time (a lock and a flush). */
const until = (ok: () => unknown, what = 'it to happen') => waitFor(ok, what);

function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = manualClock();
  const reports: string[] = [];
  const base = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
  });
  let open = true;
  /** The lease the home is on now: a run begun under an older one is refused. */
  const lease = { epoch: 1, granted: true, takes: true };
  const home = {
    storage: base.storage,
    data: { safeStorage: base.data.safeStorage },
    stores: () => (open ? {} : null),
    stamp: () => ({ homeId: 'studio', leaseEpoch: lease.epoch }),
    current: (s: any) => s.leaseEpoch === lease.epoch,
    granted: () => lease.granted,
    receiveStamp: async () => ({ ok: lease.takes }),
  };
  /** A scheduler over the same ledger: a new one is a Host that started again. */
  const make = (o: object = {}) => createMomoScheduler({ home, rules, clock, report: (m: string) => reports.push(m), ...o });
  return { dir, clock, reports, make, close: () => (open = false), reopen: () => (open = true), home, lease };
}

test('a due time runs once, its start and end are kept, a restart does not run it again, and a task that is not active is not scheduled', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const source = {
    list: () => [task('a'), task('paused', { status: 'PAUSED' })],
    run: (x: any) => void ran.push(x.id),
  };
  const first = w.make();
  assert.deepEqual((await first.tick())?.ran, [], 'no source: nothing is scheduled');
  first.setSource(source);
  assert.deepEqual((await first.tick())?.ran, []);
  w.clock.advance(60_000);
  assert.deepEqual((await first.tick())?.ran, ['a']);
  assert.deepEqual(ran, ['a']);
  assert.equal(first.status().tasks, 1, 'the paused task is not scheduled');
  // the Host stops and starts again, one period later: the due time that ran does not run twice, the next one does
  const second = w.make();
  second.setSource(source);
  w.clock.advance(60_000);
  assert.deepEqual((await second.tick())?.ran, ['a']);
  assert.equal(ran.length, 2);
});

test('a task first seen runs from now, never for the past; its rule changing re-schedules it and a task that goes away stops', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  let tasks: any[] = [task('a', { schedule_from: w.clock.now() - 9_999_999 })];
  const s = w.make();
  s.setSource({ list: () => tasks, run: (x: any) => void ran.push(`${x.id}@${x.rrule}`) });
  await s.tick();
  assert.deepEqual(ran, []);
  w.clock.advance(60_000);
  await s.tick();
  assert.deepEqual(ran, ['a@60000']);
  // its rule changes: scheduled again on the new rule; it is not told twice for one time
  tasks = [task('a', { rrule: '10000' })];
  await s.tick();
  w.clock.advance(10_000);
  await s.tick();
  assert.deepEqual(ran, ['a@60000', 'a@10000']);
  // a rule with no next time is parked, never run
  tasks = [task('a', { rrule: 'never' })];
  await s.tick();
  w.clock.advance(60_000);
  assert.deepEqual((await s.tick())?.ran, []);
  // the task goes away
  tasks = [];
  await s.tick();
  assert.equal(s.status().tasks, 0);
  w.clock.advance(60_000);
  assert.deepEqual((await s.tick())?.ran, []);
});

test('a run that declines its time is skipped and silent; one that fails is told to the source, kept as Didn’t finish, and reported', async (t) => {
  const w = world(t);
  const told: string[] = [];
  const s = w.make();
  s.setSource({
    list: () => [task('quiet'), task('bad'), task('worse')],
    run: (x: any) => {
      if (x.id === 'quiet') throw new RunSkipped('quiet-hours');
      throw new Error(`no brain for ${x.id}`);
    },
    failed: (x: any) => {
      told.push(x.id);
      if (x.id === 'worse') return Promise.reject(new Error('chat is gone'));
    },
  });
  await s.tick();
  w.clock.advance(60_000);
  const out = await s.tick();
  assert.deepEqual([out?.skipped, out?.failed.sort()], [['quiet'], ['bad', 'worse']]);
  assert.deepEqual(told.sort(), ['bad', 'worse']);
  assert.ok(w.reports.some((m) => /could not be told of its failure: chat is gone/.test(m)));
  assert.ok(w.reports.some((m) => /MoMo's task bad: no brain for bad/.test(m)));
  assert.ok(!w.reports.some((m) => /quiet/.test(m)), 'a skipped time says nothing');
  // a source with no failed hook still fails the run
  const plain = w.make();
  plain.setSource({ list: () => [task('p')], run: () => Promise.reject(new Error('x')) });
  await plain.tick();
  w.clock.advance(60_000);
  assert.deepEqual((await plain.tick())?.failed, ['p']);
});

test('nothing runs while the home has no stores (the grant ran out or no home), and a source that cannot list is reported, not fatal', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const s = w.make();
  s.setSource({ list: () => [task('a')], run: (x: any) => void ran.push(x.id) });
  await s.tick();
  w.close();
  w.clock.advance(60_000);
  assert.equal(await s.tick(), null);
  assert.deepEqual(ran, []);
  assert.equal(s.status().active, false);
  // the home is back: the time that came and went is late for the next tick or runs once, never twice
  w.reopen();
  assert.deepEqual((await s.tick())?.ran, ['a']);
  s.setSource({
    list: () => {
      throw new Error('store is busy');
    },
    run: () => undefined,
  });
  assert.equal(await s.tick(), null);
  assert.ok(w.reports.some((m) => /could not be listed: store is busy/.test(m)));
  s.setSource({ list: () => Promise.reject('plain'), run: () => undefined });
  assert.equal(await s.tick(), null);
  assert.ok(w.reports.some((m) => /could not be listed: plain/.test(m)));
});

test('a Host that stopped mid-run reads it as Didn’t finish when it is back, hands it to the source once, and never runs that time again', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const hung = w.make();
  hung.setSource({ list: () => [task('a')], run: () => (ran.push('a'), new Promise(() => undefined)) });
  await hung.tick();
  w.clock.advance(60_000);
  void hung.tick();
  await until(() => ran.length === 1);
  // the Host is gone; a new one starts
  const back = w.make();
  const handed: any[] = [];
  back.setSource({
    list: () => [task('a')],
    run: (x: any) => void ran.push(`again:${x.id}`),
    interrupted: (runs: any[]) => handed.push(...runs),
  });
  const cut = await back.recover();
  assert.deepEqual(
    cut.map((c: any) => c.id),
    ['a'],
  );
  assert.equal(handed.length, 1);
  assert.deepEqual(await back.recover(), [], 'closed once');
  // the same due time is not run again; the next one is
  assert.deepEqual((await back.tick())?.ran, []);
  assert.deepEqual(ran, ['a']);
  w.clock.advance(60_000);
  assert.deepEqual((await back.tick())?.ran, ['a']);
  // a source that cannot take the cut-off runs, and none at all, are fine
  const hung2 = w.make();
  let began = false;
  hung2.setSource({ list: () => [task('b')], run: () => ((began = true), new Promise(() => undefined)) });
  await hung2.tick();
  w.clock.advance(60_000);
  void hung2.tick();
  await until(() => began);
  const again = w.make();
  again.setSource({ list: () => [], run: () => undefined, interrupted: () => Promise.reject(new Error('chat is gone')) });
  assert.equal((await again.recover()).length, 1);
  assert.ok(w.reports.some((m) => /cut-off runs could not be handed on: chat is gone/.test(m)));
  const none = w.make();
  assert.deepEqual(await none.recover(), []);
});

test('a task record that cannot be read is reported, runs nothing stale and does not stop the tick', async (t) => {
  const w = world(t);
  const s = w.make();
  s.setSource({ list: () => [task('a')], run: () => undefined });
  await s.tick();
  w.clock.advance(60_000);
  await s.tick();
  // the key that sealed it is not this Host's any more
  w.home.data.safeStorage.decryptString = () => {
    throw new Error('wrong key');
  };
  assert.deepEqual(await w.make().recover(), []);
  assert.ok(w.reports.some((m) => /task record could not be read: .*another key/.test(m)));
  // no mark can be kept, so nothing is run, and the tick goes on
  const ran: string[] = [];
  const fresh = w.make();
  fresh.setSource({ list: () => [task('z')], run: (x: any) => void ran.push(x.id) });
  assert.deepEqual((await fresh.tick())?.ran, []);
  w.clock.advance(60_000);
  assert.deepEqual((await fresh.tick())?.failed, ['z']);
  assert.deepEqual(ran, []);
});

test('start recovers, then ticks on the clock until stop; a second start replaces the first, and a tick that throws keeps the chain going', async (t) => {
  const w = world(t);
  const ran: string[] = [];
  const s = w.make({ tickMs: 1000 });
  s.setSource({ list: () => [task('a', { rrule: '2000' })], run: (x: any) => void ran.push(x.id) });
  await s.start();
  assert.equal(s.status().state, 'running');
  assert.equal(w.clock.pending(), 1);
  await waitFor(() => ran.length >= 1, 'the task to run on the clock', {
    step: async () => {
      w.clock.advance(1000);
      // the ledger's writes are real file work: let the loop turn
      await new Promise((r) => setTimeout(r, 20));
    },
  });
  await until(() => w.clock.pending() === 1);
  await s.start();
  assert.equal(w.clock.pending(), 1, 'a second start replaced the first');
  s.stop();
  assert.equal(s.status().state, 'off');
  assert.equal(w.clock.pending(), 0);
  // a tick that throws is reported and the next one is still set
  const boom: any = w.make({ tickMs: 1000 });
  boom.tick = () => Promise.reject(new Error('tick broke'));
  await boom.start();
  w.clock.advance(1000);
  await until(() => w.reports.some((m) => /tick failed: tick broke/.test(m)));
  await until(() => w.clock.pending() === 1);
  boom.stop();
  assert.equal(w.clock.pending(), 0);
});

test('the Host’s status tells what the scheduler is doing, to a connection that presented the home’s account', async (t) => {
  const w = world(t);
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(w.dir, 'data2'),
    safeStorage: createFileSafeStorage(path.join(w.dir, 'config2')),
  });
  const host = await servedHost(t, { momo: home });
  const { conn } = await host.paired('mac', 'Mac');
  await conn.request('host.momoGrant', { account: 'a1', features: ['momo'] });
  await conn.request('host.hello', helloParams());
  assert.equal((await conn.request('host.momoStatus')).scheduler, undefined, 'a home with no scheduler says nothing of one');
  home.scheduler = createMomoScheduler({ home, rules, clock: w.clock, report: () => undefined });
  assert.deepEqual((await conn.request('host.momoStatus')).scheduler, { state: 'off', active: false, lastTickAt: 0, tasks: 0 });
  await home.start({ name: 'Studio' });
  assert.equal((await conn.request('host.momoStatus')).scheduler.active, true);
  // before the serve entry has made the day and the buttons, they are refused with the cause
  await assert.rejects(conn.request('host.momoBriefNow'), /not ready on /);
  await assert.rejects(conn.request('host.momoIntent', { key: 'dana-1', action: 'draft' }), /not ready on /);
  // the day, the pushes' problems and the view contract's settings, once the day and the push exist
  home.daily = {
    status: () => ({ on: true, today: 'failed', pendingCatchUp: false, failure: { code: 'brief_failed', fix: 'show_brief_now' } }),
  } as any;
  home.push = {
    failures: () => [
      {
        pairId: 'p1',
        code: 'notifications_off',
        since: 5,
        id: 'open_settings',
        label: 'Open Settings',
        cause: 'Notifications are off. MoMo keeps things in Chat.',
      },
    ],
    reachedAny: () => false,
  } as any;
  const status = await conn.request('host.momoStatus');
  assert.equal(status.day.today, 'failed');
  assert.equal(status.delivery[0].code, 'notifications_off');
  assert.equal(status.view.notifications, 'denied');
  assert.deepEqual(status.view.settings.quietHours, { from: '22:00', to: '08:00' });
  assert.deepEqual(
    status.view.problems.map((x: any) => x.fix.id),
    ['show_brief_now', 'open_settings'],
  );
  // the brief made at once and a notification's answer go to the day and the buttons once the serve entry has made them
  home.daily = { status: home.daily!.status, briefNow: async () => 'delivered' } as any;
  home.intents = { apply: async (p: any) => ({ ok: true, action: p.action }) } as any;
  assert.equal(await conn.request('host.momoBriefNow'), 'delivered');
  assert.deepEqual(await conn.request('host.momoIntent', { key: 'dana-1', action: 'draft' }), { ok: true, action: 'draft' });
  await home.close();
});

test('a Host with no grant reads and makes nothing: starting and ticking leave no folder behind', async (t) => {
  const w = world(t);
  const idle = createMomoScheduler({
    home: {
      storage: { dir: path.join(w.dir, 'never-made') },
      data: { safeStorage: w.home.data.safeStorage },
      stores: () => null,
      stamp: () => null,
      current: () => false,
      granted: () => false,
      receiveStamp: () => ({ ok: false }),
    },
    rules,
    clock: w.clock,
    report: () => undefined,
    tickMs: 1000,
  });
  idle.setSource({ list: () => [task('a')], run: () => undefined });
  idle.start();
  w.clock.advance(5000);
  assert.equal(await idle.tick(), null);
  assert.equal(fs.existsSync(path.join(w.dir, 'never-made')), false);
  idle.stop();
});

test('a run carries the lease epoch its tick began with, and one whose lease moved on is skipped, not run and not failed', async (t) => {
  const w = world(t);
  const seen: any[] = [];
  const s = w.make();
  s.setSource({ list: () => [task('a')], run: (x: any, ctx: any) => void seen.push([x.id, ctx.stamp]) });
  await s.tick();
  w.clock.advance(60_000);
  await s.tick();
  assert.deepEqual(seen, [['a', { homeId: 'studio', leaseEpoch: 1 }]]);
  // the lease moves between the tick's start and the run: the time is left to the new home
  w.clock.advance(60_000);
  const moving = w.make();
  moving.setSource({
    list: () => {
      w.lease.epoch = 2;
      return [task('a')];
    },
    run: (x: any) => void seen.push(x.id),
  });
  w.lease.epoch = 1;
  await moving.tick();
  w.clock.advance(60_000);
  w.lease.epoch = 1;
  const r = await moving.tick();
  assert.deepEqual([r?.ran, r?.skipped, r?.failed], [[], ['a'], []]);
  assert.equal(seen.length, 1);
});

test('what else the Host clock drives runs after the tasks at every tick, whatever the tasks did, and a failing hook does not stop the next', async (t) => {
  const w = world(t);
  const order: string[] = [];
  const s = w.make();
  s.addTickHook(async () => void order.push('first'));
  s.addTickHook(async () => {
    throw new Error('day broke');
  });
  s.addTickHook(async () => void order.push('last'));
  // no source: the hooks still run
  await s.tick();
  assert.deepEqual(order, ['first', 'last']);
  assert.match(w.reports.join('\n'), /day failed: day broke/);
  // a source that cannot list: reported, hooks still run
  s.setSource({ list: () => Promise.reject(new Error('no list')), run: () => undefined });
  await s.tick();
  assert.deepEqual(order, ['first', 'last', 'first', 'last']);
  // a home with no stores runs no hook
  w.close();
  assert.equal(await s.tick(), null);
  assert.equal(order.length, 4);
});

test('the fence fails closed and a run can ask whether its lease still stands: a tick that began with no lease runs nothing, and `live` follows the lease', async (t) => {
  const w = world(t);
  const lives: boolean[] = [];
  const s = w.make();
  s.setSource({
    list: () => [task('a')],
    run: async (_x: any, ctx: any) => {
      lives.push(await ctx.live());
      w.lease.epoch = 5;
      lives.push(await ctx.live());
      // each of the other things a lease stands on, one at a time
      w.lease.epoch = 1;
      w.lease.granted = false;
      lives.push(await ctx.live());
      w.lease.granted = true;
      w.lease.takes = false;
      lives.push(await ctx.live());
      w.lease.takes = true;
      lives.push(await ctx.live());
    },
  });
  await s.tick();
  w.clock.advance(60_000);
  await s.tick();
  assert.deepEqual(lives, [true, false, false, false, true]);
  // the lease is gone when the tick begins (the home dropped it while it was recovering): the due time is skipped
  w.lease.epoch = 1;
  const none = w.make();
  none.setSource({ list: () => [task('b')], run: () => lives.push(true) });
  const original = w.home.stamp;
  await none.tick();
  w.clock.advance(60_000);
  w.home.stamp = () => null as any;
  const r = await none.tick();
  assert.deepEqual([r?.ran, r?.skipped], [[], ['b']]);
  assert.equal(lives.length, 5);
  w.home.stamp = original;
});

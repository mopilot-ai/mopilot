// What MoMo is given by the place that runs it (M1 slice S, electron/momo/seams.cjs): its storage over either key source (Electron's safeStorage, a Host's key file) opens the same stores, and its scheduler runs each due time once, one task at a time, on an injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { act, fakeSafe } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { userError } = require('../shared/userError.mjs');
const { momoStorage, systemClock, createTickScheduler, TaskSkipped, KEY_KINDS } = require('../electron/momo/seams.cjs');
const { AuditLog } = require('../electron/momo/audit.cjs');
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');

const scratch = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-seams-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('storage needs an absolute folder and a key source that can seal, and says which key it has', (t) => {
  const dir = scratch(t);
  const safe = fakeSafe();
  const made = momoStorage({ dir, keySource: { kind: 'electron', safeStorage: safe } });
  assert.deepEqual({ dir: made.dir, keys: made.keys, safe: made.safeStorage === safe }, { dir, keys: 'electron', safe: true });
  assert.ok(Object.isFrozen(made));
  assert.deepEqual([...KEY_KINDS], ['electron', 'key-file']);
  assert.throws(() => momoStorage({ dir: 'relative', keySource: { kind: 'electron', safeStorage: safe } }), /absolute folder/);
  assert.throws(() => momoStorage({ dir: 7 as any, keySource: { kind: 'electron', safeStorage: safe } }), /absolute folder/);
  assert.throws(() => momoStorage({ dir, keySource: undefined as any }), /key source/);
  assert.throws(() => momoStorage({ dir, keySource: { kind: 'keychain' as any, safeStorage: safe } }), /key source/);
  assert.throws(() => momoStorage({ dir, keySource: { kind: 'key-file', safeStorage: null as any } }), /cannot seal/);
  assert.throws(
    () => momoStorage({ dir, keySource: { kind: 'key-file', safeStorage: { encryptString: () => Buffer.alloc(0) } as any } }),
    /cannot seal/,
  );
});

test('the stores open over a Host key file: sealed values and the audit chain survive a restart of the same folder', async (t) => {
  const dir = scratch(t);
  const open = () =>
    momoStorage({
      dir: path.join(dir, 'momo'),
      keySource: { kind: 'key-file', safeStorage: createFileSafeStorage(path.join(dir, 'config')) },
    });
  const first = open();
  const sealed = new SealedJson({ file: path.join(first.dir, 'x.json'), safeStorage: first.safeStorage, shape: (v: any) => v ?? { n: 0 } });
  await sealed.change((v: any) => void (v.n = 3));
  assert.doesNotMatch(fs.readFileSync(path.join(first.dir, 'x.json'), 'utf8'), /"n"/, 'the value is sealed on the disk');
  const log = new AuditLog({ dir: path.join(first.dir, 'audit'), safeStorage: first.safeStorage });
  const { id } = await log.intent(act);
  await log.outcome(id, { result: 'done', note: 'ok' });
  await log.close();
  // the next run of the same Host: a new key source over the same files
  const again = open();
  const reread = new SealedJson({ file: path.join(again.dir, 'x.json'), safeStorage: again.safeStorage, shape: (v: any) => v ?? { n: 0 } });
  assert.deepEqual(reread.read(), { n: 3 });
  const log2 = new AuditLog({ dir: path.join(again.dir, 'audit'), safeStorage: again.safeStorage });
  assert.equal(log2.available(), true);
  assert.deepEqual(await log2.verify(), { ok: true, entries: 2, from: 1, last: 2 });
  await log2.close();
});

test('the system clock is the real one', async () => {
  assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000);
  let fired = 0;
  const cancel = systemClock.after(() => fired++, 5);
  const never = systemClock.after(() => fired++, 5);
  never();
  await new Promise((r) => setTimeout(r, 30));
  cancel();
  assert.equal(fired, 1);
});

/** A clock the test moves by hand; `after` timers fire when it is advanced past them. */
function manualClock(start = 1_000_000) {
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
const every = (ms: number) => (after: number) => after + ms;

test('a task runs once per due time: a late one runs once, a very late one is recorded late, a failing one is recorded Didn’t finish and reported while the next still runs', async () => {
  const clock = manualClock();
  const reported: [string, string][] = [];
  const seen: [string, number, string][] = [];
  const ran: [string, number][] = [];
  const sched = createTickScheduler({
    clock,
    lateMs: 10_000,
    report: (id: string, e: any) => reported.push([id, e.message]),
    record: (o: any) => seen.push([o.id, o.dueAt, o.status + (o.error ? `:${o.error}` : '')]),
  });
  sched.add({ id: 'a', next: every(1000), run: (d: number) => void ran.push(['a', d]) });
  sched.add({ id: 'bad', next: every(1000), run: () => Promise.reject(new Error('no brain')) });
  sched.add({ id: 'never', next: () => null, run: () => assert.fail('a task with no due time never runs') });
  assert.deepEqual(
    sched.list().map((t: any) => t.id),
    ['a', 'bad', 'never'],
  );
  assert.deepEqual(await sched.tick(), { ran: [], failed: [], late: [], skipped: [], busy: false });
  clock.advance(1000);
  assert.deepEqual(await sched.tick(), { ran: ['a'], failed: ['bad'], late: [], skipped: [], busy: false });
  assert.deepEqual(reported, [['bad', 'no brain']]);
  assert.deepEqual(seen, [
    ['a', 1_001_000, 'started'],
    ['a', 1_001_000, 'ran'],
    ['bad', 1_001_000, 'started'],
    ['bad', 1_001_000, `didnt-finish:${userError(new Error('no brain'))}`],
  ]);
  // five periods pass with no tick: one run for the due time that was missed, then the schedule goes on from now
  clock.advance(5000);
  assert.deepEqual((await sched.tick()).ran, ['a']);
  assert.deepEqual(ran, [
    ['a', 1_001_000],
    ['a', 1_002_000],
  ]);
  assert.equal(sched.list().find((t: any) => t.id === 'a').dueAt, 1_007_000);
  // later than the late limit: not run, recorded late, and the next due time is still set
  seen.length = 0;
  clock.advance(60_000);
  const late = await sched.tick();
  assert.deepEqual([late.ran, late.late.sort()], [[], ['a', 'bad']]);
  assert.deepEqual(
    seen.map((o) => o[2]),
    ['late', 'late'],
  );
  assert.equal(ran.length, 2);
  sched.remove('a');
  assert.deepEqual(
    sched.list().map((t: any) => t.id),
    ['bad', 'never'],
  );
});

test('a task that waited only for another task’s long run is not late; a record that throws never breaks a tick and a run whose start could not be recorded does not start', async () => {
  const clock = manualClock();
  const reported: string[] = [];
  const sched = createTickScheduler({
    clock,
    lateMs: 1000,
    report: (id: string) => reported.push(id),
    record: (o: any) => {
      if (o.id === 'b' && o.status === 'started') throw new Error('disk full');
    },
  });
  const ran: string[] = [];
  sched.add({ id: 'a', next: every(10), run: () => (ran.push('a'), clock.advance(5000)) });
  sched.add({ id: 'b', next: every(10), run: () => void ran.push('b') });
  clock.advance(10);
  // a runs for five seconds; b was due when the tick began, so it runs rather than being late for a's sake
  assert.deepEqual(await sched.tick(), { ran: ['a'], failed: ['b'], late: [], skipped: [], busy: false });
  assert.deepEqual(reported, ['b'], 'the failed record is reported');
  assert.deepEqual(ran, ['a'], 'b was not run without its mark');
  // the same schedule, but the tick began after the limit: now b is late
  const again = createTickScheduler({ clock, lateMs: 1000 });
  again.add({ id: 'a', since: 0, next: every(10), run: () => void ran.push('late-a') });
  assert.deepEqual((await again.tick()).late, ['a']);
});

test('a task whose next due time is not after now is parked and reported, and a clock that moves back runs nothing twice', async () => {
  const clock = manualClock();
  const reported: [string, string][] = [];
  const sched = createTickScheduler({ clock, report: (id: string, e: any) => reported.push([id, e.message]) });
  let runs = 0;
  sched.add({ id: 'stuck', next: (after: number) => after, run: () => void runs++ });
  assert.deepEqual(sched.list(), [{ id: 'stuck', dueAt: clock.now() }]);
  assert.deepEqual((await sched.tick()).ran, ['stuck']);
  assert.deepEqual((await sched.tick()).ran, [], 'parked: not every tick');
  assert.equal(runs, 1);
  assert.deepEqual(reported, [['stuck', 'its next due time is not after now, so it is parked']]);
  assert.deepEqual(sched.list(), [{ id: 'stuck', dueAt: null }]);
  // backward clock: an hour back, the task that ran waits for the clock; nothing runs a second time
  const hourly: number[] = [];
  const sched2 = createTickScheduler({ clock });
  sched2.add({ id: 'h', next: every(3_600_000), run: (d: number) => void hourly.push(d) });
  clock.advance(3_600_000);
  assert.deepEqual((await sched2.tick()).ran, ['h']);
  clock.advance(-3_600_000);
  assert.deepEqual((await sched2.tick()).ran, []);
  clock.advance(3_600_000);
  assert.deepEqual((await sched2.tick()).ran, [], 'its next hour has not come yet');
  clock.advance(3_600_000);
  assert.deepEqual((await sched2.tick()).ran, ['h']);
  assert.equal(hourly.length, 2);
});

test('a task whose next throws is parked and recorded and the others still run; a run that never settles is recorded Didn’t finish after the bound and frees the tick; a start mark that cannot be recorded stops that run only', async () => {
  const clock = manualClock();
  const seen: [string, string][] = [];
  const reported: [string, string][] = [];
  const sched = createTickScheduler({
    clock,
    runTimeoutMs: 5000,
    report: (id: string, e: any) => reported.push([id, String(e?.message ?? e)]),
    record: (o: any) => {
      seen.push([o.id, o.status]);
      if (o.id === 'rejecting') return Promise.reject(new Error('disk full'));
    },
  });
  // `breaks` has a due time when added; its next throws when asked for the one after that
  let armed = false;
  sched.add({
    id: 'breaks',
    next: (after: number) => {
      if (armed) throw new Error('bad rule');
      return after + 10;
    },
    run: () => assert.fail('it does not run'),
  });
  armed = true;
  sched.add({ id: 'hangs', next: every(10), run: () => new Promise(() => undefined) });
  sched.add({ id: 'rejecting', next: every(10), run: () => undefined });
  sched.add({ id: 'ok', next: every(10), run: () => undefined });
  clock.advance(10);
  const first = sched.tick();
  await new Promise((r) => setImmediate(r));
  // `hangs` is running; the bound passes and the tick goes on to the tasks after it
  clock.advance(5000);
  const out = await first;
  assert.deepEqual(out.failed.sort(), ['breaks', 'hangs', 'rejecting']);
  assert.deepEqual(out.ran, ['ok']);
  assert.ok(reported.some(([id, m]) => id === 'hangs' && /did not finish in time/.test(m)));
  assert.ok(reported.some(([id, m]) => id === 'breaks' && /bad rule/.test(m)));
  assert.ok(reported.some(([id, m]) => id === 'rejecting' && /disk full/.test(m)));
  assert.deepEqual(
    sched.list().find((t: any) => t.id === 'breaks'),
    { id: 'breaks', dueAt: null },
  );
  assert.equal(seen.filter(([id, st]) => id === 'hangs' && st === 'didnt-finish').length, 1);
  // the tick was freed: the next one runs what is due
  sched.remove('hangs');
  clock.advance(10);
  assert.deepEqual((await sched.tick()).ran, ['ok']);
});

test('a run that declines its time on purpose is recorded skipped, says nothing and is not a failure', async () => {
  const clock = manualClock();
  const seen: string[] = [];
  const reported: string[] = [];
  const sched = createTickScheduler({
    clock,
    report: (id: string) => reported.push(id),
    record: (o: any) => void seen.push(`${o.id}:${o.status}`),
  });
  sched.add({
    id: 'quiet',
    next: every(10),
    run: () => {
      throw new TaskSkipped('quiet-hours');
    },
  });
  sched.add({ id: 'plain', next: every(10), run: () => undefined });
  clock.advance(10);
  assert.deepEqual(await sched.tick(), { ran: ['plain'], failed: [], late: [], skipped: ['quiet'], busy: false });
  assert.deepEqual(seen, ['quiet:started', 'quiet:skipped', 'plain:started', 'plain:ran']);
  assert.deepEqual(reported, []);
  assert.equal(new TaskSkipped('x').reason, 'x');
});

test('start survives a tick that rejects and keeps ticking', async () => {
  const clock = manualClock();
  const reported: string[] = [];
  const sched = createTickScheduler({ clock, report: (id: string) => reported.push(id) });
  sched.add({ id: 'a', next: every(100), run: () => undefined });
  const real = sched.tick.bind(sched);
  let calls = 0;
  sched.tick = async () => {
    if (!calls++) throw new Error('boom');
    return real();
  };
  sched.start(100);
  clock.advance(100);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reported, ['tick']);
  assert.equal(clock.pending(), 1, 'the chain goes on');
  sched.stop();
});

test('the default report notes the failure and a restart reads the last handled time (since)', async () => {
  const clock = manualClock();
  const sched = createTickScheduler({ clock });
  const ran: number[] = [];
  // handled at 998_000: its next due time (999_000) already passed, so one run catches up
  sched.add({ id: 'a', since: 998_000, next: every(1000), run: (d: number) => void ran.push(d) });
  sched.add({ id: 'bad', next: every(1), run: () => Promise.reject(new Error('x')) });
  clock.advance(1);
  assert.deepEqual((await sched.tick()).ran, ['a']);
  assert.deepEqual(ran, [999_000]);
  clock.advance(1);
  assert.deepEqual((await sched.tick()).failed, ['bad']);
  // a failure that is not an Error is recorded by its text
  const texts: string[] = [];
  const odd = createTickScheduler({ clock, record: (o: any) => o.error && texts.push(o.error), report: () => undefined });
  odd.add({ id: 'o', next: every(1), run: () => Promise.reject('plain') });
  clock.advance(1);
  await odd.tick();
  assert.deepEqual(texts, [userError('plain')]);
});

test('a tick during a running one is skipped, never queued; a task removed or replaced while its tick runs does not run again', async () => {
  const clock = manualClock();
  const sched = createTickScheduler({ clock });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  sched.add({ id: 'slow', next: every(10), run: async () => (ran.push('slow'), await gate) });
  sched.add({ id: 'gone', next: every(10), run: () => void ran.push('gone') });
  sched.add({ id: 'swapped', next: every(10), run: () => void ran.push('old') });
  clock.advance(10);
  const first = sched.tick();
  assert.deepEqual(await sched.tick(), { ran: [], failed: [], late: [], skipped: [], busy: true });
  sched.remove('gone');
  sched.add({ id: 'swapped', next: every(10), run: () => void ran.push('new') });
  release();
  assert.deepEqual((await first).ran, ['slow']);
  assert.deepEqual(ran, ['slow']);
  clock.advance(10);
  assert.deepEqual((await sched.tick()).ran.sort(), ['slow', 'swapped']);
  assert.deepEqual(ran.slice(1).sort(), ['new', 'slow']);
});

test('start ticks on the clock until stop; a second start replaces the first and a stop during a tick ends the chain', async () => {
  const clock = manualClock();
  const sched = createTickScheduler({ clock });
  const ran: number[] = [];
  sched.add({ id: 'a', next: every(100), run: (d: number) => void ran.push(d) });
  sched.start(100);
  sched.start(100);
  assert.equal(clock.pending(), 1, 'one chain, not two');
  clock.advance(100);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [1_000_100]);
  assert.equal(clock.pending(), 1);
  // stopped while a tick runs: it finishes, and nothing is scheduled after it
  let release: () => void = () => undefined;
  sched.add({ id: 'b', next: every(100), run: () => new Promise<void>((r) => (release = r)) });
  clock.advance(100);
  await new Promise((r) => setImmediate(r));
  sched.stop();
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.pending(), 0);
  sched.stop();
});

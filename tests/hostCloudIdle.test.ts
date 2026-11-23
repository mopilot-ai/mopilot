// A cloud machine's Host stops its own machine when idle (host/src/cloudIdle.mjs, shared/host/cloudPolicy.mjs, plan C2): the policy block that makes a Host a cloud machine, the probes and the timer around the pure decision, the hours kept across a restart, and the status it reports. W: a machine that stops with something still going, A: the clients and the schedules that keep it up, B: the settings, I: a store or a halt that fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudIdle, CLIENT_QUIET_MS, TICK_MS } from '../host/src/cloudIdle.mjs';
import { parseCloud, mergeCloud } from '../shared/host/cloudPolicy.mjs';
import { hostLayerOf } from '../shared/host/managedLayer.mjs';
import { mergePolicy, parseOwnerPolicy } from '../shared/host/policy.mjs';

const MIN = 60_000;
const bad = (m: string) => new Error(m);
const idleBusy = { turnRunning: false, cardWaiting: false, queued: false };

test('B: the cloud block holds whole minutes and hours, drops what it does not know, and a managed limit only lowers a machine that has one', () => {
  assert.deepEqual(parseCloud({ idleMinutes: 30, hoursPerDay: 8, other: 1 }, bad), { idleMinutes: 30, hoursPerDay: 8 });
  assert.deepEqual(parseCloud({ hoursPerDay: null }, bad), {}, 'no cap');
  for (const raw of [
    null,
    [],
    'x',
    { idleMinutes: 0 },
    { idleMinutes: 10_081 },
    { idleMinutes: 1.5 },
    { hoursPerDay: 0 },
    { hoursPerDay: 25 },
  ])
    assert.throws(() => parseCloud(raw, bad), /Cloud settings|Stop when idle|Hours per day/);
  assert.deepEqual(mergeCloud({ idleMinutes: 90 }, { idleMinutes: 60, hoursPerDay: 8 }), { idleMinutes: 60, hoursPerDay: 8 });
  assert.deepEqual(mergeCloud({ idleMinutes: 30, hoursPerDay: 4 }, { idleMinutes: 60, hoursPerDay: 8 }), {
    idleMinutes: 30,
    hoursPerDay: 4,
  });
  assert.equal(mergeCloud(undefined, { idleMinutes: 60 }), undefined, 'a Host that is not a cloud machine is not made one');
  // through the document: only the app's document for a cloud machine carries the block; a managed document's limits lower it
  const owner = parseOwnerPolicy({ version: 1, cloud: { idleMinutes: 90 } }, bad);
  const layer = hostLayerOf({ cloud: { idleMinutesMax: 60, hoursPerDayMax: 12 } });
  assert.deepEqual(layer.cloud, { idleMinutes: 60, hoursPerDay: 12 });
  assert.deepEqual(mergePolicy(owner, layer).doc.cloud, { idleMinutes: 60, hoursPerDay: 12 });
  assert.deepEqual(hostLayerOf({ cloud: {} }).cloud, {});
  const plain = parseOwnerPolicy({ version: 1 }, bad);
  assert.equal(mergePolicy(plain, layer).doc.cloud, undefined, 'no cloud block, no cloud machine');
});

/** A Host with its probes, clock and halts in hand. */
function world(config: any = { idleMinutes: 30 }, over: any = {}) {
  let clock = Date.UTC(2026, 10, 16, 10, 0, 0);
  const calls: string[] = [];
  const files = new Map<string, string>(over.files ?? []);
  const busy = { ...idleBusy };
  const reports: string[] = [];
  let next: number | null = null;
  const cfg = { value: config };
  const idle = createCloudIdle({
    dataDir: '/data',
    config: () => cfg.value,
    busy: () => busy,
    nextScheduleAt: () => next,
    flush: async () => void calls.push('flush'),
    halt: over.halt ?? (async () => void calls.push('halt')),
    now: () => clock,
    report: (m) => reports.push(m),
    io: {
      readFileSync: (f: any) => {
        if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files.get(f)!;
      },
      writeFileSync: (f: any, text: any) => {
        if (over.writeFails) throw new Error('disk full');
        files.set(f, String(text));
      },
    } as any,
  });
  return {
    idle,
    calls,
    files,
    busy,
    reports,
    cfg,
    advance: (ms: number) => (clock += ms),
    schedule: (at: number | null) => (next = at),
    at: () => clock,
  };
}

test('W: a Host that is not a cloud machine never stops and reports no cloud status', async () => {
  const w = world(null);
  assert.equal(w.idle.status(), null);
  w.advance(1000 * MIN);
  assert.equal(await w.idle.tick(), false);
  assert.deepEqual(w.calls, []);
});

test('W: after the idle time with nothing going on the Host says it is stopping, writes out, then halts the machine', async () => {
  const w = world({ idleMinutes: 30 });
  assert.equal(await w.idle.tick(), false);
  w.advance(29 * MIN);
  assert.equal(await w.idle.tick(), false, 'one minute short');
  assert.equal(w.idle.status()?.stopping, false);
  w.advance(MIN);
  assert.equal(await w.idle.tick(), true);
  assert.deepEqual(w.calls, ['flush', 'halt']);
  assert.deepEqual(w.idle.status(), { idleMinutes: 30, stopping: true, hoursToday: 0.5, reason: 'idle' });
});

test('A: a turn, a card, a queued message, a schedule soon and a client that just asked each keep the machine up', async () => {
  const w = world({ idleMinutes: 10 });
  await w.idle.tick();
  for (const [name, hold, release] of [
    ['a turn', () => (w.busy.turnRunning = true), () => (w.busy.turnRunning = false)],
    ['a card', () => (w.busy.cardWaiting = true), () => (w.busy.cardWaiting = false)],
    ['a queued message', () => (w.busy.queued = true), () => (w.busy.queued = false)],
    ['a schedule due soon', () => w.schedule(w.at() + 5 * MIN), () => w.schedule(null)],
  ] as const) {
    hold();
    w.advance(60 * MIN);
    assert.equal(await w.idle.tick(), false, name);
    release();
  }
  // a client that asked a moment ago counts for one quiet minute, then the idle time begins
  w.idle.touch();
  w.advance(CLIENT_QUIET_MS - 1);
  assert.equal(await w.idle.tick(), false, 'a client that just asked');
  w.advance(1);
  assert.equal(await w.idle.tick(), false, 'the idle time begins here');
  w.advance(10 * MIN);
  assert.equal(await w.idle.tick(), true);
});

test('B: a changed setting takes effect at once, and the hours run today are kept across a restart', async () => {
  const w = world({ idleMinutes: 30, hoursPerDay: 1 });
  await w.idle.tick();
  w.advance(30 * MIN);
  await w.idle.tick();
  assert.match(w.files.get('/data/cloud-hours.json')!, /"ms":1800000/);
  w.cfg.value = { idleMinutes: 5, hoursPerDay: 1 };
  assert.equal(w.idle.status()?.idleMinutes, 5);
  // a new Host process the same day starts from the hours already run
  const again = world(
    { idleMinutes: 600, hoursPerDay: 1 },
    { files: [['/data/cloud-hours.json', w.files.get('/data/cloud-hours.json')!]] },
  );
  assert.equal(again.idle.status()?.hoursToday, 0.5, 'the same day only: another day starts at zero');
  const day = new Date(again.at()).toISOString().slice(0, 10);
  const other = world({ idleMinutes: 600 }, { files: [['/data/cloud-hours.json', JSON.stringify({ day: '2020-01-01', ms: 5e6 })]] });
  assert.equal(other.idle.status()?.hoursToday, 0);
  assert.ok(day);
});

test('I: a store that cannot be kept or read is said or ignored, and a halt that fails leaves the Host running and trying again', async () => {
  const unreadable = world({ idleMinutes: 30 }, { files: [['/data/cloud-hours.json', '{not json']] });
  assert.equal(unreadable.idle.status()?.hoursToday, 0);
  const full = world({ idleMinutes: 30 }, { writeFails: true });
  await full.idle.tick();
  assert.match(full.reports[0], /the hours run today could not be kept \(disk full\)/);
  const stuck = world({ idleMinutes: 1 }, { halt: async () => Promise.reject(new Error('no sudo')) });
  await stuck.idle.tick();
  stuck.advance(MIN);
  await stuck.idle.tick();
  assert.match(stuck.reports.at(-1)!, /the machine did not stop \(no sudo\)/);
  assert.equal(stuck.idle.status()?.stopping, false);
});

test('W: the timer looks every half minute, never keeps the process alive, and stops when asked', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = world({ idleMinutes: 1 });
  const stop = w.idle.start();
  w.advance(MIN);
  t.mock.timers.tick(TICK_MS);
  await new Promise((r) => setImmediate(r));
  w.advance(MIN);
  t.mock.timers.tick(TICK_MS);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.calls, ['flush', 'halt'], 'a look by the timer found it idle');
  stop();
});

test('I: with only what it needs, a Host looks at itself, finds nothing to keep, and says nothing of a store it cannot write', async () => {
  const idle = createCloudIdle({
    dataDir: '/nonexistent-data-dir-for-the-test',
    config: () => ({ idleMinutes: 30 }),
    busy: () => idleBusy,
    nextScheduleAt: () => null,
    flush: async () => undefined,
  });
  assert.equal(await idle.tick(), false);
  assert.equal(idle.status()?.stopping, false);
});

// The Host desktop's reading and service (G8 #3903): a capability that is only as true as the last fresh reading of the helper, and the service that builds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createDesktopProbe } from '../host/src/desktopProbe.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostDesktop } from '../host/src/desktopService.mjs';
import { deferred, tick } from './support/async-scenarios.ts';

// the probe

function probeWorld(over: { installed?: boolean; status?: any } = {}) {
  let t = 0;
  const timers: { fn: () => void; unref: () => void; cleared: boolean }[] = [];
  const calls: any[] = [];
  const gate: { current: ReturnType<typeof deferred<any>> | null } = { current: null };
  const world = {
    status: over.status ?? { accessibility: true, screenRecording: true, inputMonitoring: false },
    fail: null as Error | null,
  };
  const probe = createDesktopProbe({
    installed: over.installed ?? true,
    call: async (method: string, params: any, opts: any) => {
      calls.push([method, params, opts]);
      if (gate.current) await gate.current.promise;
      if (world.fail) throw world.fail;
      return world.status;
    },
    now: () => t,
    setTimer: ((fn: () => void) => {
      const timer = { fn, unref() {}, cleared: false };
      timers.push(timer);
      return timer;
    }) as any,
    clearTimer: (timer: any) => void (timer.cleared = true),
  });
  return { probe, calls, timers, advance: (ms: number) => void (t += ms), world, gate };
}

test('probe: nothing is true before the first reading; a reading with the needed grants is true, and only while fresh', async () => {
  const w = probeWorld();
  assert.equal(w.probe.ok(), false);
  assert.match(w.probe.why(), /not checked/);
  await w.probe.refresh();
  assert.equal(w.probe.ok(), true);
  assert.equal(w.probe.why(), '');
  assert.deepEqual(w.calls, [['permissions.status', {}, { timeoutMs: 10_000 }]]);
  w.advance(90_001);
  assert.equal(w.probe.ok(), false, 'a cached true after the session could have changed is not a capability');
  assert.match(w.probe.why(), /not confirmed its desktop lately/);
});

test('probe: a missing grant, an unreachable helper and no helper at all each read false with the reason', async () => {
  const missing = probeWorld({ status: { accessibility: true, screenRecording: false } });
  await missing.probe.refresh();
  assert.equal(missing.probe.ok(), false);
  assert.match(missing.probe.why(), /Screen Recording/);
  const both = probeWorld({ status: {} });
  await both.probe.refresh();
  assert.match(both.probe.why(), /Accessibility and Screen Recording/);
  const down = probeWorld();
  down.world.fail = new Error('helper timed out');
  await down.probe.refresh();
  assert.match(down.probe.why(), /cannot reach its desktop: helper timed out/);
  down.world.fail = new (class extends Error {})() as any;
  down.advance(1);
  await down.probe.refresh();
  assert.equal(down.probe.ok(), false);
  const odd = probeWorld();
  odd.world.fail = 'plain string' as any;
  await odd.probe.refresh();
  assert.match(odd.probe.why(), /plain string/);
  const none = probeWorld({ installed: false });
  await none.probe.refresh();
  assert.equal(none.probe.ok(), false);
  assert.match(none.probe.why(), /not installed/);
  assert.equal(none.calls.length, 0, 'no helper to start, so nothing was asked');
});

test('probe: readings are one at a time, and a recheck lets go of one that began before it', async () => {
  const w = probeWorld();
  w.gate.current = deferred();
  const first = w.probe.refresh();
  const second = w.probe.refresh();
  assert.equal(first, second, 'one reading in flight');
  assert.equal(w.calls.length, 1);
  w.probe.recheck();
  assert.equal(w.probe.ok(), false);
  assert.match(w.probe.why(), /checking/);
  assert.equal(w.calls.length, 2, 'a new reading started at once');
  // the old reading finishes with a true answer that began before the recheck: it is not kept
  w.world.status = { accessibility: false, screenRecording: false };
  const old = w.gate.current;
  w.gate.current = null;
  old.resolve({});
  await first;
  await tick();
  assert.equal(w.probe.ok(), false);
  assert.match(w.probe.why(), /macOS has not granted/);
});

test('probe: start reads now and then on a timer; stop ends it and later readings keep nothing', async () => {
  const w = probeWorld();
  w.probe.start();
  w.probe.start();
  await tick();
  assert.equal(w.calls.length, 1);
  assert.equal(w.probe.ok(), true);
  assert.equal(w.timers.length, 1, 'one timer however often it is started');
  w.timers[0].fn();
  await tick();
  assert.equal(w.calls.length, 2);
  w.probe.stop();
  assert.equal(w.timers[0].cleared, true);
  w.probe.stop();
  await w.probe.refresh();
  w.probe.recheck();
  assert.equal(w.calls.length, 2, 'a stopped probe asks nothing more');
});
test('service: a Host with no helper provisioned reads desktop false; with one it is read, never started by status', async () => {
  const made: any[] = [];
  const epochs: any = { onAdvance: () => () => undefined, current: () => 1, admit: () => 1 };
  const none = createHostDesktop({
    dataDir: '/data',
    env: {},
    epochs,
    platform: 'darwin',
    makeHelper: (opts: any) => {
      made.push(opts);
      return { installed: false, running: false, call: async () => ({}), stop: () => undefined } as any;
    },
  });
  assert.equal(made[0].appPath, '/data/helper/MoPilot Code.app');
  assert.equal(made[0].platform, 'darwin');
  assert.equal(none.available(), false);
  none.start();
  await tick();
  assert.equal(none.available(), false);
  await none.dispose();

  const asked: string[] = [];
  const some = createHostDesktop({
    dataDir: '/data',
    env: { MOPILOT_HOST_HELPER: '/opt/helper.app' },
    epochs,
    platform: 'darwin',
    makeHelper: (opts: any) => {
      made.push(opts);
      return {
        installed: true,
        running: true,
        call: async (method: string) => (asked.push(method), { accessibility: true, screenRecording: true }),
        stop: () => asked.push('stop'),
      } as any;
    },
  });
  assert.equal(made[1].appPath, '/opt/helper.app');
  assert.equal(some.available(), false, 'nothing is known until the first reading');
  assert.deepEqual(asked, []);
  some.start();
  await tick();
  assert.equal(some.available(), true);
  assert.deepEqual(asked, ['permissions.status']);
  const seat = some.protocol.connection();
  await seat.call('desktop.lease', { chatId: 'c1', epoch: 1, apps: ['a.b'] });
  const other = some.protocol.connection();
  await assert.rejects(other.call('desktop.lease', { chatId: 'c2', epoch: 1, apps: ['a.b'] }), (e: any) => e.code === 'busy');
  seat.close();
  await some.dispose();
  assert.deepEqual(
    asked.filter((m) => m === 'stop'),
    ['stop'],
  );
});

test('service: the real helper class is built when none is passed', () => {
  const svc = createHostDesktop({
    dataDir: '/nonexistent-data',
    env: {},
    epochs: { onAdvance: () => () => undefined, current: () => 1, admit: () => 1, all: () => [] },
    platform: 'linux',
  });
  assert.equal(svc.available(), false);
  svc.start();
  return svc.dispose();
});

test('probe: the helper app provisioned after the Host started is found at the next reading', async () => {
  let there = false;
  const asked: string[] = [];
  const probe = createDesktopProbe({
    installed: () => there,
    call: async (m: string) => (asked.push(m), { accessibility: true, screenRecording: true }),
  });
  await probe.refresh();
  assert.equal(probe.ok(), false);
  assert.deepEqual(asked, []);
  there = true;
  probe.recheck();
  await probe.refresh();
  assert.equal(probe.ok(), true);
});

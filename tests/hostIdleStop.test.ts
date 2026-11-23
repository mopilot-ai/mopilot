// Idle stop (C2): each idle condition on a mocked clock and the edge at exactly the idle time; the hours cap waits for the running turn; the Host says it is stopping and writes its journal first; a failed halt is not a stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIdleStop, osHalt, DEFAULT_IDLE_MINUTES } from '../host/src/idleStop.mjs';
import { hostStatus } from '../host/src/status.mjs';

const MIN = 60_000;
const quiet = { turnRunning: false, cardWaiting: false, queued: false, nextScheduleAt: null as number | null, clientActive: false };

function setup(config: any = { idleMinutes: 30 }, saved: any = null) {
  let t = Date.parse('2026-11-14T10:00:00Z');
  const state = {
    probe: { ...quiet },
    order: [] as string[],
    saved,
    halt: async () => void state.order.push('halt'),
    reports: [] as Error[],
    told: [] as any[],
  };
  const idle = createIdleStop({
    config,
    probe: () => state.probe,
    now: () => t,
    flush: async () => void state.order.push('flush'),
    halt: () => state.halt(),
    store: { read: () => state.saved, write: (v) => (state.saved = v) },
    report: (e) => state.reports.push(e),
  });
  idle.onChange((s) => state.told.push(s));
  return { idle, state, advance: (ms: number) => (t += ms), at: () => t };
}

test('a quiet machine stops after exactly the idle time, not a moment before, flushing the journal first', async () => {
  const { idle, state, advance } = setup();
  assert.equal(await idle.tick(), false);
  advance(30 * MIN - 1);
  assert.equal(await idle.tick(), false);
  advance(1);
  assert.equal(await idle.tick(), true);
  assert.deepEqual(state.order, ['flush', 'halt']);
  assert.equal(idle.status().stopping, true);
  assert.equal(idle.status().reason, 'idle');
  assert.deepEqual(state.told[0], { idleMinutes: 30, stopping: true, hoursToday: 0.5, reason: 'idle' });
  assert.equal(await idle.tick(), false);
  assert.equal(DEFAULT_IDLE_MINUTES, 30);
});

for (const [name, busy] of [
  ['a turn running', { turnRunning: true }],
  ['a card waiting', { cardWaiting: true }],
  ['a queued message', { queued: true }],
  ['a client connected and sending', { clientActive: true }],
] as const) {
  test(`${name} keeps the machine up, and the idle time starts again when it ends`, async () => {
    const { idle, state, advance } = setup();
    state.probe = { ...quiet, ...busy };
    for (let i = 0; i < 4; i++) {
      advance(20 * MIN);
      assert.equal(await idle.tick(), false);
    }
    state.probe = { ...quiet };
    assert.equal(await idle.tick(), false);
    advance(29 * MIN);
    assert.equal(await idle.tick(), false);
    advance(1 * MIN);
    assert.equal(await idle.tick(), true);
  });
}

test('a schedule due within the idle time keeps it up; one further out does not', async () => {
  const { idle, state, advance, at } = setup();
  state.probe = { ...quiet, nextScheduleAt: at() + 30 * MIN };
  advance(30 * MIN);
  state.probe = { ...quiet, nextScheduleAt: at() + 30 * MIN };
  assert.equal(await idle.tick(), false);
  state.probe = { ...quiet, nextScheduleAt: at() + 30 * MIN + 1 };
  assert.equal(await idle.tick(), false);
  advance(30 * MIN);
  state.probe = { ...quiet, nextScheduleAt: at() + 30 * MIN + 1 };
  assert.equal(await idle.tick(), true);
});

test('the hours cap stops the machine once the running turn has finished, whatever else waits', async () => {
  const { idle, state, advance } = setup({ idleMinutes: 600, hoursPerDay: 2 });
  state.probe = { ...quiet, turnRunning: true, queued: true };
  advance(2 * 3_600_000);
  assert.equal(await idle.tick(), false);
  advance(MIN);
  assert.equal(await idle.tick(), false);
  assert.equal(idle.status().hoursToday, 2.02);
  state.probe = { ...quiet, queued: true, cardWaiting: true, clientActive: true };
  assert.equal(await idle.tick(), true);
  assert.equal(idle.status().reason, 'hours');
  assert.deepEqual(state.order, ['flush', 'halt']);
});

test('the hours run today survive a restart and reset on a new day; no cap means none', async () => {
  const day = '2026-11-14';
  const a = setup({ idleMinutes: 600, hoursPerDay: 1 }, { day, ms: 3_600_000 });
  assert.equal(await a.idle.tick(), true);
  const b = setup({ idleMinutes: 600, hoursPerDay: 1 }, { day: '2026-11-13', ms: 99 * 3_600_000 });
  assert.equal(await b.idle.tick(), false);
  b.state.probe = { ...quiet, turnRunning: true };
  b.advance(15 * 3_600_000);
  assert.equal(await b.idle.tick(), false);
  assert.equal(b.idle.status().hoursToday, 1);
  assert.equal(b.state.saved.day, '2026-11-15');
  const none = setup({ idleMinutes: 600 });
  none.state.probe = { ...quiet, turnRunning: true };
  none.advance(40 * 3_600_000);
  assert.equal(await none.idle.tick(), false);
  assert.equal(setup({}).idle.status().idleMinutes, 30);
  assert.equal(setup({ idleMinutes: 0 }).idle.status().idleMinutes, 1);
});

test('a halt that fails is reported, the Host is no longer stopping, and it may try again', async () => {
  const { idle, state, advance } = setup();
  state.halt = async () => {
    throw new Error('no permission');
  };
  await idle.tick();
  advance(30 * MIN);
  assert.equal(await idle.tick(), true);
  assert.equal(idle.status().stopping, false);
  assert.equal(state.reports[0].message, 'no permission');
  assert.equal(state.told.at(-1).stopping, false);
  assert.equal(await idle.tick(), false);
  advance(30 * MIN);
  state.halt = async () => void state.order.push('halt');
  assert.equal(await idle.tick(), true);
  assert.equal(state.order.at(-1), 'halt');
});

test('a listener can stop listening, and host.status carries the cloud block only on a cloud machine', () => {
  const { idle } = setup();
  const off = idle.onChange(() => assert.fail('not told'));
  off();
  const base = { running: true, harnesses: [], peerCheck: true } as any;
  assert.equal('cloud' in hostStatus(base), false);
  assert.deepEqual(hostStatus({ ...base, cloud: idle.status() }).cloud, { idleMinutes: 30, stopping: false, hoursToday: 0 });
});

test('osHalt tries sudo first and then the plain call, and fails when both do', async () => {
  const calls: string[][] = [];
  const make = (codes: Array<number | 'error'>) =>
    ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter();
      const code = codes.shift()!;
      setImmediate(() => (code === 'error' ? child.emit('error', new Error('ENOENT')) : child.emit('exit', code)));
      return child;
    }) as any;
  await osHalt(make([0]))();
  assert.deepEqual(calls, [['sudo', '-n', 'systemctl', 'poweroff']]);
  calls.length = 0;
  await osHalt(make(['error', 0]))();
  assert.deepEqual(calls[1], ['systemctl', 'poweroff']);
  await assert.rejects(osHalt(make([1, 1]))(), /halt exited 1/);
});

test('with no report listener, a halt that fails is still survived', async () => {
  let t = Date.parse('2026-11-14T10:00:00Z');
  const idle = createIdleStop({
    config: {},
    probe: () => quiet,
    now: () => t,
    flush: async () => undefined,
    halt: async () => {
      throw new Error('nope');
    },
    store: { read: () => null, write: () => undefined },
  });
  await idle.tick();
  t += 30 * MIN;
  assert.equal(await idle.tick(), true);
  assert.equal(idle.status().stopping, false);
});

// A relay socket that has been quiet is asked to prove it is alive; one that does not answer is reported dead, once, for its own connection only.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const modulePath = '../mobile/src/relayLiveness.ts';
const { createRelayLiveness, QUIET_MS, ANSWER_MS } = await import(modulePath);

const rig = (over: Record<string, unknown> = {}) => {
  const log = { probes: 0, dead: [] as number[], heard: 0 };
  let tick: (() => void) | null = null;
  let cleared = 0;
  let generation = 1;
  let quiet = QUIET_MS;
  const o = {
    probe: async () => {
      log.probes++;
    },
    dead: (owner: number) => log.dead.push(owner),
    generation: () => generation,
    quietFor: () => quiet,
    heard: () => log.heard++,
    timers: {
      setEvery: (fn: () => void) => {
        tick = fn;
        return 'timer';
      },
      clear: () => cleared++,
    },
    ...over,
  };
  const liveness = createRelayLiveness(o);
  return {
    liveness,
    log,
    tick: () => tick!(),
    cleared: () => cleared,
    set: (g: number, q: number) => ((generation = g), (quiet = q)),
    started: () => tick !== null,
  };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a socket heard from recently is not asked, a quiet one is, and an answer is recorded as heard', async () => {
  const r = rig();
  r.liveness.start(1);
  r.set(1, QUIET_MS - 1);
  r.tick();
  await flush();
  assert.equal(r.log.probes, 0);
  r.set(1, QUIET_MS);
  r.tick();
  await flush();
  assert.deepEqual([r.log.probes, r.log.heard, r.log.dead], [1, 1, []]);
});

test('a socket whose question fails is dead, and only for the connection that asked', async () => {
  const r = rig({
    probe: async () => {
      throw new Error('relay disconnected');
    },
  });
  r.liveness.start(1);
  r.tick();
  await flush();
  assert.deepEqual(r.log.dead, [1]);
  // the connection moved on while the question was out: nothing is replaced for the old one
  const late = rig({ probe: () => Promise.reject(new Error('x')) });
  late.liveness.start(1);
  late.set(2, QUIET_MS);
  late.tick();
  await flush();
  assert.deepEqual(late.log.dead, []);
});

test('a socket that never answers is dead after the answer time, and one question runs at a time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let asked = 0;
    const r = rig({
      probe: () => {
        asked++;
        return new Promise(() => {});
      },
    });
    r.liveness.start(1);
    r.tick();
    r.tick();
    assert.equal(asked, 1, 'a second check while one is out asks nothing');
    mock.timers.tick(ANSWER_MS - 1);
    await flush();
    assert.deepEqual(r.log.dead, []);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(r.log.dead, [1]);
    r.tick();
    assert.equal(asked, 2, 'asking again is possible once the question ended');
  } finally {
    mock.timers.reset();
  }
});

test('a new start replaces the watch and a stop clears it', () => {
  const r = rig();
  assert.equal(r.started(), false);
  r.liveness.start(1);
  r.liveness.start(1);
  assert.equal(r.cleared(), 1, 'the first watch was cleared when the second began');
  r.liveness.stop();
  r.liveness.stop();
  assert.equal(r.cleared(), 2, 'stopping a stopped watch clears nothing more');
});

test('without timers of its own it checks on the real interval, and stopping ends it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let probes = 0;
    const liveness = createRelayLiveness({
      probe: async () => void probes++,
      dead: () => {},
      generation: () => 1,
      quietFor: () => QUIET_MS,
      heard: () => {},
    });
    liveness.start(1);
    mock.timers.tick(QUIET_MS);
    await flush();
    assert.equal(probes, 1);
    liveness.stop();
    mock.timers.tick(QUIET_MS * 3);
    await flush();
    assert.equal(probes, 1);
  } finally {
    mock.timers.reset();
  }
});

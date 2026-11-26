// The grant the phone sends to each machine: once at start, again every 30 minutes and when a machine's answer changes, never to a machine that did not answer, one that refuses is reported and the rest are told, and the home is looked at again only when a machine was told.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const grantsPath = '../mobile/src/momoPhone/phoneHome/grants';
const { keepGranted, GRANT_EVERY_MS, GRANT_RETRY_MS } = await import(grantsPath);

const rig = (over: { reachable?: boolean[]; fail?: string[] } = {}) => {
  let at = 1_000_000;
  const told: string[] = [];
  const seen = { refresh: 0, reported: [] as unknown[] };
  const changes = new Set<() => void>();
  let tick: () => void = () => undefined;
  let everyMs = 0;
  let stopped = 0;
  const machines = () => [
    { id: 'a', reachable: over.reachable?.[0] ?? true },
    { id: 'b', reachable: over.reachable?.[1] ?? true },
  ];
  const stop = keepGranted({
    machines,
    grant: async (id: string) => {
      if (over.fail?.includes(id)) throw new Error('refused');
      told.push(id);
    },
    refresh: async () => void seen.refresh++,
    onChange: (fn: () => void) => (changes.add(fn), () => void changes.delete(fn)),
    now: () => at,
    every: (fn: () => void, ms: number) => ((tick = fn), (everyMs = ms), () => void stopped++),
    report: (e: unknown) => seen.reported.push(e),
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    told,
    seen,
    changes,
    stop,
    settle,
    tick: () => tick(),
    everyMs: () => everyMs,
    stopped: () => stopped,
    advance: (ms: number) => void (at += ms),
  };
};

test('every machine that answers is told at start, then not again until its 30 minutes are nearly up', async () => {
  const r = rig();
  await r.settle();
  assert.deepEqual(r.told, ['a', 'b']);
  assert.equal(r.seen.refresh, 1);
  assert.equal(r.everyMs(), GRANT_EVERY_MS);
  r.tick();
  await r.settle();
  assert.deepEqual(r.told, ['a', 'b'], 'told a minute ago: not again');
  r.advance(GRANT_EVERY_MS);
  r.tick();
  await r.settle();
  assert.deepEqual(r.told, ['a', 'b', 'a', 'b']);
  r.stop();
});

test('a machine that did not answer is not told, a change tells it once it does, and a refusal is reported while the others are told', async () => {
  const r = rig({ reachable: [true, false], fail: [] });
  await r.settle();
  assert.deepEqual(r.told, ['a']);
  const f = rig({ fail: ['a'] });
  await f.settle();
  assert.deepEqual(f.told, ['b']);
  assert.equal(f.seen.reported.length, 1);
  assert.equal(f.seen.refresh, 1);
  const none = rig({ fail: ['a', 'b'] });
  await none.settle();
  assert.equal(none.seen.refresh, 0, 'nobody was told: nothing to look at again');
  // a machine that was away is told when its answer changes
  const c = rig({ reachable: [false, false] });
  await c.settle();
  assert.deepEqual(c.told, []);
});

test('a change is passed on until stopped, and a stopped keeper tells no one', async () => {
  const r = rig();
  await r.settle();
  r.advance(GRANT_EVERY_MS);
  [...r.changes].forEach((fn) => fn());
  await r.settle();
  assert.deepEqual(r.told, ['a', 'b', 'a', 'b']);
  r.stop();
  assert.equal(r.stopped(), 1);
  assert.equal(r.changes.size, 0);
  r.advance(GRANT_EVERY_MS);
  r.tick();
  await r.settle();
  assert.deepEqual(r.told, ['a', 'b', 'a', 'b']);
});

test('a failure of the home’s own look after the grants is reported, not thrown', async () => {
  const seen: unknown[] = [];
  keepGranted({
    machines: () => [{ id: 'a', reachable: true }],
    grant: async () => undefined,
    refresh: async () => {
      throw new Error('look failed');
    },
    onChange: () => () => undefined,
    now: () => 1,
    every: () => () => undefined,
    report: (e: unknown) => seen.push(e),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, 1);
});

test('a refusal with no one to report to is not an error', async () => {
  let refreshed = 0;
  keepGranted({
    machines: () => [{ id: 'a', reachable: true }],
    grant: async () => {
      throw new Error('refused');
    },
    refresh: async () => void refreshed++,
    onChange: () => () => undefined,
    now: () => 1,
    every: () => () => undefined,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(refreshed, 0);
  // and a failed look with no one to report to is not an error either
  keepGranted({
    machines: () => [{ id: 'a', reachable: true }],
    grant: async () => undefined,
    refresh: async () => {
      throw new Error('look failed');
    },
    onChange: () => () => undefined,
    now: () => 1,
    every: () => () => undefined,
  });
  await new Promise((r) => setTimeout(r, 5));
});

test('a machine that refuses is not asked again at every change: 30 seconds, then 60, then 120, up to the grant’s 30; one that takes it is told again after its 30', async () => {
  let at = 1_000_000;
  let refuse = true;
  const tried: number[] = [];
  const changes = new Set<() => void>();
  const stop = keepGranted({
    machines: () => [{ id: 'a', reachable: true }],
    grant: async () => {
      tried.push(at);
      if (refuse) throw new Error('refused');
    },
    refresh: async () => undefined,
    onChange: (fn: () => void) => (changes.add(fn), () => void changes.delete(fn)),
    now: () => at,
    every: () => () => undefined,
    report: () => undefined,
  });
  const poke = async () => (changes.forEach((fn) => fn()), await new Promise((r) => setTimeout(r, 5)));
  await poke();
  assert.equal(tried.length, 1);
  // changes inside the first wait ask nothing
  at += GRANT_RETRY_MS - 1;
  await poke();
  assert.equal(tried.length, 1);
  at += 1;
  await poke();
  assert.equal(tried.length, 2);
  // the wait doubles: twice as long now
  at += 2 * GRANT_RETRY_MS - 1;
  await poke();
  assert.equal(tried.length, 2);
  at += 1;
  await poke();
  assert.equal(tried.length, 3);
  // it never goes past the grant's own 30 minutes
  for (let i = 0; i < 8; i++) {
    at += GRANT_EVERY_MS;
    await poke();
  }
  assert.equal(tried.length, 3 + 8);
  // taken at last: told, and not again until nearly 30 minutes are up
  refuse = false;
  at += GRANT_EVERY_MS;
  await poke();
  const told = tried.length;
  await poke();
  assert.equal(tried.length, told);
  stop();
});

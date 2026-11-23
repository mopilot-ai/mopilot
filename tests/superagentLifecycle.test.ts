// Superagent lifecycle (electron/superagent/index.cjs): the flag, draining on close, retry with backoff for a locked database, and damage that waits for a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { StoreDamagedError, StoreNewerError } = require('../electron/superagent/store/index.cjs');
const { createSuperagent } = require('../electron/superagent/index.cjs');

function fakeStore(log: string[]) {
  return {
    drain: async () => {
      log.push('drain');
    },
    close: () => {
      log.push('close');
    },
  };
}

test('lifecycle: off opens nothing; on opens; off drains then closes; a handler is never cut off', async () => {
  let on = false;
  const log: string[] = [];
  let opened = 0;
  const sa = createSuperagent({
    enabled: () => on,
    openStore: () => {
      opened++;
      return fakeStore(log);
    },
  });
  assert.equal(sa.sync(), undefined);
  assert.deepEqual([opened, sa.store, sa.error], [0, null, null]);
  on = true;
  sa.sync();
  sa.sync();
  assert.equal(opened, 1);
  on = false;
  const closing = sa.sync();
  assert.equal(sa.store, null, 'no new work is handed out while it drains');
  assert.equal(sa.sync(), closing, 'a second flip waits on the same close');
  await closing;
  assert.deepEqual(log, ['drain', 'close']);
  assert.equal(sa.sync(), undefined);
  // flipped back on while it was still closing: it opens only after the close finished
  on = true;
  sa.sync();
  on = false;
  const c2 = sa.sync();
  on = true;
  const reopened = sa.sync();
  await Promise.all([c2, reopened]);
  assert.ok(sa.store);
  assert.equal(opened, 3);
});

test('lifecycle: a locked database is retried with backoff and recovers; damage waits for a person', async () => {
  let on = true;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const errors: Error[] = [];
  let attempt = 0;
  const log: string[] = [];
  const sa = createSuperagent({
    enabled: () => on,
    openStore: () => {
      attempt++;
      if (attempt <= 3) throw new Error('database is locked');
      return fakeStore(log);
    },
    onError: (e: Error) => errors.push(e),
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (h: unknown) => cleared.push(h),
  });
  sa.sync();
  assert.match(sa.error.message, /locked/);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [1000],
  );
  timers[0].fn();
  timers[1].fn();
  assert.deepEqual(
    timers.map((t) => t.ms),
    [1000, 2000, 4000],
  );
  timers[2].fn();
  assert.ok(sa.store, 'recovered by itself');
  assert.equal(sa.error, null);
  assert.equal(errors.length, 3);

  // a cap on the backoff, and the retry timer is cancelled when the flag goes off
  on = false;
  await sa.sync();
  on = true;
  attempt = 0;
  const capped = createSuperagent({
    enabled: () => on,
    openStore: () => {
      throw new Error('locked');
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 99;
    },
    clearTimer: (h: unknown) => cleared.push(h),
  });
  for (let i = 0; i < 9; i++) {
    capped.sync();
    capped.clearError();
  }
  assert.equal(timers.at(-1)?.ms, 1000, 'clearError resets the backoff');
  const again = createSuperagent({
    enabled: () => on,
    openStore: () => {
      throw new Error('locked');
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 5;
    },
    clearTimer: (h: unknown) => cleared.push(h),
  });
  const before = timers.length;
  for (let i = 0; i < 9; i++) {
    timers.at(-1)?.fn();
    again.sync();
  }
  assert.equal(timers.at(-1)?.ms, 60_000, 'capped at a minute');
  assert.ok(timers.length > before);
  on = false;
  again.sync();
  assert.ok(cleared.includes(5), 'the pending retry is cancelled when the flag goes off');

  // damage and a newer schema are not retried
  on = true;
  const tries: number[] = [];
  const damaged = createSuperagent({
    enabled: () => on,
    openStore: () => {
      tries.push(1);
      throw new StoreDamagedError('bad', 'x');
    },
    setTimer: () => assert.fail('no retry'),
  });
  damaged.sync();
  damaged.sync();
  assert.equal(tries.length, 1);
  damaged.clearError();
  damaged.sync();
  assert.equal(tries.length, 2);
  const newer = createSuperagent({
    enabled: () => true,
    openStore: () => {
      throw new StoreNewerError(9, 1);
    },
    setTimer: () => assert.fail('no retry'),
  });
  newer.sync();
  assert.ok(newer.error);
});

test('the default timers: a failed open waits for its retry (no early retry), and a flag-off cancels it', async () => {
  let n = 0;
  const sa = createSuperagent({
    enabled: () => on,
    openStore: () => {
      n++;
      throw new Error('locked');
    },
  });
  let on = true;
  sa.sync();
  sa.sync();
  sa.sync();
  assert.equal(n, 1, 'calls in between do not retry');
  assert.equal(sa.error.message, 'locked');
  on = false;
  sa.sync(); // cancels the pending retry with the default clearTimer
  on = true;
  sa.sync();
  assert.equal(n, 2, 'the cancelled retry no longer blocks a new attempt');
});

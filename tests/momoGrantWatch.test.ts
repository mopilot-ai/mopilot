// Waiting for a macOS privacy switch (#2528, shared/grantWatch.cjs): reads the grant on a timer, finishes by itself when it is on, gives up after its timeout, can be cancelled or replaced, and a failing read or finish never leaves a stuck wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GrantWatch, INTERVAL_MS, TIMEOUT_MS } = require('../shared/grantWatch.cjs');

/** A watch on a fake clock: each sleep advances it, so a run needs no real time. */
function fixture(o: { granted?: (n: number) => boolean | Promise<boolean>; onGranted?: (...a: any[]) => any } = {}) {
  const t = { now: 0, reads: 0, finished: [] as any[], changes: 0, errors: [] as string[] };
  const w = new GrantWatch({
    isGranted: async () => (o.granted ?? (() => false))(++t.reads),
    onGranted: o.onGranted ?? ((name: string, ctx: any) => void t.finished.push([name, ctx])),
    onChange: () => void t.changes++,
    onError: (what: string) => void t.errors.push(what),
    intervalMs: 1000,
    timeoutMs: 5000,
    sleep: async (ms: number) => void (t.now += ms),
    now: () => t.now,
  });
  const done = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  return { t, w, done };
}

test('defaults: read every 2 seconds, give up after 3 minutes', () => {
  assert.deepEqual([INTERVAL_MS, TIMEOUT_MS], [2000, 180_000]);
  assert.ok(new GrantWatch({ isGranted: async () => false, onGranted: () => {} }).names().length === 0);
});

test('finishes with its context when the grant turns on, then is no longer waiting', async () => {
  const { t, w, done } = fixture({ granted: (n) => n === 3 });
  w.start('calendar', 7);
  assert.deepEqual(w.names(), ['calendar']);
  await done();
  assert.deepEqual(t.finished, [['calendar', 7]]);
  assert.equal(t.reads, 3);
  assert.deepEqual(w.names(), []);
  assert.equal(t.changes, 2, 'one change when it started, one when it ended');
});

test('gives up at the timeout without finishing', async () => {
  const { t, w, done } = fixture();
  w.start('calendar', 1);
  await done();
  assert.deepEqual(t.finished, []);
  assert.equal(t.reads, 5);
  assert.deepEqual(w.names(), []);
});

test('cancel stops it; nothing finishes, and cancelling nothing says so', async () => {
  const { t, w, done } = fixture({ granted: () => true });
  w.start('calendar', 1);
  assert.equal(w.cancel('calendar'), true);
  assert.equal(w.cancel('calendar'), false);
  await done();
  assert.deepEqual(t.finished, []);
  assert.equal(t.reads, 0, 'cancelled before its first read');
});

test('a cancel while the grant is being read leaves the connect to the user', async () => {
  let release!: (v: boolean) => void;
  const { t, w, done } = fixture({ granted: () => new Promise<boolean>((r) => (release = r)) });
  w.start('calendar', 1);
  await done();
  w.cancel('calendar');
  release(true);
  await done();
  assert.deepEqual(t.finished, []);
});

test('starting again replaces the running wait: only the new one finishes', async () => {
  const { t, w, done } = fixture({ granted: (n) => n > 1 });
  w.start('calendar', 'old');
  w.start('calendar', 'new');
  await done();
  assert.deepEqual(t.finished, [['calendar', 'new']]);
  assert.deepEqual(w.names(), []);
});

test('a failing read counts as not granted yet; a failing finish ends the wait', async () => {
  const flaky = fixture({
    granted: (n) => {
      if (n === 1) throw new Error('helper restarting');
      return true;
    },
  });
  flaky.w.start('calendar', 1);
  await flaky.done();
  assert.deepEqual(flaky.t.finished, [['calendar', 1]]);
  assert.match(flaky.t.errors[0], /read a macOS grant/);
  const broken = fixture({
    granted: () => true,
    onGranted: () => {
      throw new Error('MoMo is not available');
    },
  });
  broken.w.start('calendar', 1);
  await broken.done();
  assert.deepEqual(broken.w.names(), []);
  assert.match(broken.t.errors[0], /finish a connect/);
});

test('an owner that throws on a change never breaks a wait', async () => {
  const errors: string[] = [];
  const seen: string[] = [];
  const w = new GrantWatch({
    isGranted: async () => true,
    onGranted: (n: string) => void seen.push(n),
    onChange: () => {
      throw new Error('window gone');
    },
    onError: (what: string) => void errors.push(what),
    intervalMs: 0,
    sleep: async () => {},
  });
  w.start('calendar', null);
  assert.equal(w.cancel('calendar'), true);
  w.start('calendar', null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['calendar']);
  assert.ok(errors.length >= 3 && errors.every((e) => /announce a change/.test(e)));
  assert.deepEqual(w.names(), []);
});

test('with the real timer it reads after the interval', async () => {
  const seen: string[] = [];
  const w = new GrantWatch({ isGranted: async () => true, onGranted: (n: string) => void seen.push(n), intervalMs: 1 });
  w.start('reminders', null);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, ['reminders']);
});

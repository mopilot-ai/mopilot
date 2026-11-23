// The shared poll scheduler: one timer per key, parked while the window is hidden, one staggered wake when it shows or focuses.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { visiblePoll, pollKeyCount } from '../src/lib/visiblePoll.ts';

let hidden = false;
Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
const setHidden = (value: boolean) => {
  hidden = value;
  window.document.dispatchEvent(new window.Event('visibilitychange'));
};
const focus = () => window.dispatchEvent(new window.Event('focus'));
/** Lets the wake of this tick end, so the next event is a new one. */
const nextTick = () => Promise.resolve();

beforeEach(() => {
  hidden = false;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => mock.timers.reset());

test('callers with one key share a single timer and each run on every tick', () => {
  const a: number[] = [];
  const b: number[] = [];
  const stopA = visiblePoll('k', 1000, () => a.push(1));
  const stopB = visiblePoll('k', 1000, () => b.push(1));
  assert.equal(pollKeyCount(), 1);
  mock.timers.tick(3000);
  assert.deepEqual([a.length, b.length], [3, 3]);
  stopA();
  stopA();
  mock.timers.tick(1000);
  assert.deepEqual([a.length, b.length], [3, 4], 'a stopped caller no longer runs; stopping twice is harmless');
  stopB();
  assert.equal(pollKeyCount(), 0);
  mock.timers.tick(5000);
  assert.equal(b.length, 4);
});

test('the shortest interval of a key wins', () => {
  let n = 0;
  const slow = visiblePoll('k', 5000, () => n++);
  const fast = visiblePoll('k', 1000, () => n++);
  mock.timers.tick(5000);
  assert.equal(n, 10, 'both callers run on the faster timer');
  const late = visiblePoll('k', 9000, () => n++);
  slow();
  fast();
  late();
});

test('nothing runs while the window is hidden, and a start while hidden waits', () => {
  let n = 0;
  const stop = visiblePoll('k', 1000, () => n++);
  setHidden(true);
  mock.timers.tick(10_000);
  assert.equal(n, 0);
  const second = visiblePoll('other', 1000, () => n++);
  mock.timers.tick(10_000);
  assert.equal(n, 0, 'a poll started while hidden does not run either');
  stop();
  second();
});

test('showing the window runs every caller once and restarts the timer', () => {
  const seen: string[] = [];
  const a = visiblePoll('a', 1000, () => seen.push('a'));
  const b = visiblePoll('b', 1000, () => seen.push('b'), { wake: false });
  setHidden(true);
  setHidden(false);
  assert.deepEqual(seen, ['a'], 'a caller that opted out of the wake waits for its tick');
  mock.timers.tick(1000);
  assert.deepEqual(seen, ['a', 'a', 'b']);
  a();
  b();
});

test('a timer that fires after the window hid parks itself', () => {
  let n = 0;
  const stop = visiblePoll('k', 1000, () => n++);
  hidden = true; // no visibilitychange event arrived
  mock.timers.tick(1000);
  assert.equal(n, 0);
  mock.timers.tick(5000);
  assert.equal(n, 0, 'parked: the timer is gone');
  stop();
});

test('focus wakes callers one after another so a long list does not read in one frame', async () => {
  const order: number[] = [];
  const stops = [0, 1, 2].map((i) => visiblePoll('rows', 60_000, () => order.push(i)));
  focus();
  assert.deepEqual(order, [0], 'the first reads at once');
  mock.timers.tick(40);
  assert.deepEqual(order, [0, 1]);
  mock.timers.tick(40);
  assert.deepEqual(order, [0, 1, 2]);
  await nextTick();
  hidden = true;
  focus();
  mock.timers.tick(1000);
  assert.equal(order.length, 3, 'a focus event while hidden wakes nothing');
  for (const stop of stops) stop();
});

test('a caller that stops before its staggered wake is not run, and a new wake replaces a pending one', async () => {
  const order: string[] = [];
  const first = visiblePoll('rows', 60_000, () => order.push('first'));
  const second = visiblePoll('rows', 60_000, () => order.push('second'));
  focus();
  second();
  mock.timers.tick(100);
  assert.deepEqual(order, ['first']);
  await nextTick();
  focus();
  mock.timers.tick(100);
  assert.deepEqual(order, ['first', 'first']);
  first();
  const third = visiblePoll('rows', 60_000, () => order.push('third'));
  const fourth = visiblePoll('rows', 60_000, () => order.push('fourth'));
  await nextTick();
  focus();
  third();
  fourth();
  mock.timers.tick(100);
  assert.deepEqual(order.slice(2), ['third']);
});

test('showing and focusing in one tick wakes each caller once', async () => {
  const order: string[] = [];
  const a = visiblePoll('rows', 60_000, () => order.push('a'));
  const b = visiblePoll('rows', 60_000, () => order.push('b'));
  setHidden(true);
  setHidden(false);
  focus();
  mock.timers.tick(100);
  assert.deepEqual(order, ['a', 'b']);
  await nextTick();
  focus();
  assert.deepEqual(order.slice(2), ['a'], 'the next tick wakes again');
  mock.timers.tick(100);
  a();
  b();
});

test('a long list is spread over the interval instead of landing together past a cap', () => {
  const at: number[] = [];
  let now = 0;
  const stops = Array.from({ length: 100 }, () => visiblePoll('many', 1000, () => at.push(now)));
  focus();
  for (now = 1; now < 1000; now++) mock.timers.tick(1);
  assert.equal(at.length, 100);
  assert.ok(new Set(at).size >= 99, 'each caller reads at its own moment');
  assert.ok(Math.max(...at) < 1000, 'all within one interval');
  for (const stop of stops) stop();
});

test('when the fastest caller leaves, the key slows to the shortest left', () => {
  let slow = 0;
  const a = visiblePoll('k', 5000, () => slow++);
  const fast = visiblePoll('k', 1000, () => {});
  mock.timers.tick(5000);
  assert.equal(slow, 5);
  fast();
  mock.timers.tick(5000);
  assert.equal(slow, 6, 'back to one run per 5 s');
  fast();
  const same = visiblePoll('k', 5000, () => slow++);
  same();
  a();
});

test('an Infinity interval runs on the wake only', () => {
  let n = 0;
  const stop = visiblePoll('wake-only', Infinity, () => n++);
  mock.timers.tick(100_000);
  assert.equal(n, 0);
  focus();
  assert.equal(n, 1);
  stop();
});

test('a failing caller does not stop the others', () => {
  const errors = mock.method(console, 'error', () => {});
  const seen: string[] = [];
  const bad = visiblePoll('k', 1000, () => {
    throw new Error('boom');
  });
  const good = visiblePoll('k', 1000, () => seen.push('good'));
  mock.timers.tick(1000);
  assert.deepEqual(seen, ['good']);
  assert.equal(errors.mock.callCount(), 1);
  errors.mock.restore();
  bad();
  good();
});

test('the page listeners go with the last caller', () => {
  let n = 0;
  const stop = visiblePoll('k', 1000, () => n++);
  stop();
  setHidden(true);
  setHidden(false);
  focus();
  assert.equal(n, 0);
});

test('without a document the poll runs on its timer, as a visible window, and stops cleanly', () => {
  const doc = globalThis.document;
  (globalThis as any).document = undefined;
  try {
    let n = 0;
    const stop = visiblePoll('no-dom', 1000, () => n++);
    mock.timers.tick(3000);
    assert.equal(n, 3);
    stop();
    mock.timers.tick(3000);
    assert.equal(n, 3);
  } finally {
    (globalThis as any).document = doc;
  }
});

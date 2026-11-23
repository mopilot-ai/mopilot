// electron/platform/ports/clock.cjs: the global clock reads Date and the timers when called (so node:test's mock.timers
// reaches a module on the port), an installed clock is read at each use, and null puts the global one back; the shared
// fake (tests/support/ports/clock.ts) runs timers only as the test moves time, in time order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeClock, useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { clock, installClock } = require('../electron/platform/ports/clock.cjs');

test('the global clock reads Date and the timers when called, so mock.timers reaches it', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 5000 });
  assert.equal(clock.now(), 5000);
  const ran: string[] = [];
  const once = clock.setTimeout(() => ran.push('once'), 10);
  const gone = clock.setTimeout(() => ran.push('cleared'), 10);
  clock.clearTimeout(gone);
  const every = clock.setInterval(() => ran.push('every'), 4);
  t.mock.timers.tick(10);
  clock.clearInterval(every);
  t.mock.timers.tick(10);
  assert.deepEqual(ran, ['every', 'every', 'once']);
  assert.ok(once);
});

test('an installed clock is read at each use, and null puts the global one back', () => {
  const fake = fakeClock(42);
  const previous = installClock(fake);
  assert.equal(clock.now(), 42);
  assert.equal(installClock(null), fake);
  assert.notEqual(installClock(previous), fake);
  assert.ok(Math.abs(clock.now() - Date.now()) < 1000);
});

test('the fake runs each timer once its time comes, earliest first, including one a timer sets', (t) => {
  const c = useFakeClock(t, 100);
  const ran: [string, number][] = [];
  c.setTimeout((x: string) => ran.push([x, c.now()]), 30, 'late');
  c.setTimeout(() => {
    ran.push(['early', c.now()]);
    c.setTimeout(() => ran.push(['nested', c.now()]), 5);
  }, 10);
  const cleared = c.setTimeout(() => ran.push(['cleared', c.now()]), 20);
  c.clearTimeout(cleared);
  const byNumber = c.setTimeout(() => ran.push(['by number', c.now()]), 20);
  c.clearTimeout(Number(byNumber));
  assert.equal(c.pending, 2);
  c.advance(12);
  assert.deepEqual(ran, [['early', 110]]);
  assert.equal(c.now(), 112);
  c.advance(100);
  assert.deepEqual(ran, [
    ['early', 110],
    ['nested', 115],
    ['late', 130],
  ]);
  assert.equal(c.pending, 0);
  // a handle can be unref'd or ref'd as Node's can, and clearing nothing is harmless
  const h = c.setTimeout(() => {}, undefined);
  assert.equal(h.unref().id, h.ref().id);
  assert.equal(h.hasRef(), true);
  c.clearTimeout(null);
  c.advance(0);
  assert.equal(c.pending, 0);
});

test('the fake repeats an interval every period until it is cleared, and is taken out after the test', async (t) => {
  await t.test('interval', (sub) => {
    const c = useFakeClock(sub);
    let n = 0;
    const every = c.setInterval(() => n++, 10);
    c.advance(35);
    assert.equal(n, 3);
    c.clearInterval(every);
    c.advance(100);
    assert.equal(n, 3);
    // a zero period runs at once, then every millisecond
    const fast = c.setInterval(() => n++, 0);
    c.advance(2);
    c.clearInterval(fast);
    assert.equal(n, 6);
    assert.equal(clock.now(), c.now());
  });
  assert.ok(Math.abs(clock.now() - Date.now()) < 1000);
});

// A committed quit ends within a deadline, so a window a native sheet holds open cannot keep the app alive (#3977: SIGTERM ignored for 70 minutes with a file panel open).
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, loadMain, unloadMain } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const { quitDeadline } = require('../electron/platform/exitGate.cjs');

after(() => unloadMain());

test('quitDeadline: exits once after the wait, skips it when the quit was taken back, and can arm again', () => {
  const timers: Array<() => void> = [];
  const exits: number[] = [];
  const arm = quitDeadline(
    5,
    (code: number) => exits.push(code),
    (fn: () => void) => timers.push(fn),
  );
  assert.equal(arm({ stillQuitting: () => false }), true);
  assert.equal(arm(), false, 'one timer at a time');
  timers[0]();
  assert.deepEqual(exits, [], 'the quit was taken back (the user kept the app open)');
  assert.equal(arm(), true);
  timers[1]();
  assert.deepEqual(exits, [0]);
});

test('main: a held quit arms nothing, a committed one exits at the deadline, one taken back does not', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = await loadMain();
  await h.ready();
  const gate = h.inst.exitGate[0];
  const e = { preventDefault: mock.fn() };
  // the user is being asked: nothing runs out
  gate.request = mock.fn(async () => false);
  h.app.emit('before-quit', e);
  await flush();
  mock.timers.tick(60_000);
  assert.equal(h.app.exit.mock.callCount(), 0);
  // committed, then taken back (the gate reopened): no exit
  gate.passed = true;
  h.app.emit('before-quit', e);
  gate.passed = false;
  mock.timers.tick(10_000);
  assert.equal(h.app.exit.mock.callCount(), 0, 'a quit taken back does not exit');
  // committed: the app exits at the deadline whatever still holds a window
  gate.passed = true;
  h.app.emit('before-quit', e);
  mock.timers.tick(9_000);
  assert.equal(h.app.exit.mock.callCount(), 0);
  mock.timers.tick(1_000);
  assert.deepEqual(h.app.exit.mock.calls.at(-1)!.arguments, [0]);
  mock.timers.reset();
});

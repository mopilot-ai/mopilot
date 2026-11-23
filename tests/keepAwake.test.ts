// The keep-awake holds (electron/platform/keepAwake.cjs): one OS blocker shared by the chats holding it, each hold ending
// with its turn, its idle time, the chat's stop, crash, deletion or archive, its cap, or the app quitting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeepAwake, IDLE_MS, MAX_HOLD_MS } = require('../electron/platform/keepAwake.cjs');

function setup(over: { blocker?: any } = {}) {
  const log: string[] = [];
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const blocker =
    over.blocker === undefined
      ? {
          start: (type: string) => (log.push(`start ${type}`), nextId++),
          stop: (id: number) => log.push(`stop ${id}`),
        }
      : over.blocker;
  const k = new KeepAwake({
    blocker,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimer: (t: number) => void timers.delete(t),
  });
  const fire = (ms: number) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) timers.delete(id), t.fn();
  };
  return { k, log, timers, fire };
}

test('without an OS blocker nothing can be held', () => {
  const { k, log } = setup({ blocker: null });
  assert.equal(k.available, false);
  assert.equal(k.hold('a', 'turn_end'), 'unavailable');
  assert.equal(k.isHeld('a'), false);
  assert.deepEqual(log, []);
});

test('a turn_end hold lets go when its turn finishes; the blocker stops with the last hold', () => {
  const { k, log } = setup();
  assert.equal(k.available, true);
  assert.equal(k.hold('a', 'turn_end'), 'held');
  assert.equal(k.hold('b', 'turn_end'), 'held');
  assert.deepEqual(log, ['start prevent-app-suspension'], 'one OS blocker for both chats');
  k.turnFinished('a');
  assert.equal(k.isHeld('a'), false);
  assert.equal(k.isHeld('b'), true);
  assert.deepEqual(log, ['start prevent-app-suspension']);
  k.turnFinished('b');
  assert.deepEqual(log, ['start prevent-app-suspension', 'stop 1']);
  // a finish for a chat that holds nothing, and a release of one, change nothing
  k.turnFinished('b');
  k.turnStarted('b');
  k.release('b');
  assert.deepEqual(log, ['start prevent-app-suspension', 'stop 1']);
});

test('a session_idle hold outlasts the turn, counts down while idle and starts over when a turn begins', () => {
  const { k, timers, fire, log } = setup();
  k.hold('a', 'session_idle');
  k.turnFinished('a');
  assert.equal(k.isHeld('a'), true);
  assert.deepEqual([...timers.values()].map((t) => t.ms).sort(), [IDLE_MS, MAX_HOLD_MS].sort());
  // a follow-up turn stops the countdown
  k.turnStarted('a');
  assert.deepEqual(
    [...timers.values()].map((t) => t.ms),
    [MAX_HOLD_MS],
  );
  k.turnStarted('a');
  // a second finish replaces the countdown rather than adding one
  k.turnFinished('a');
  k.turnFinished('a');
  assert.equal([...timers.values()].filter((t) => t.ms === IDLE_MS).length, 1);
  fire(IDLE_MS);
  assert.equal(k.isHeld('a'), false);
  assert.equal(timers.size, 0, 'both timers are cleared');
  assert.deepEqual(log, ['start prevent-app-suspension', 'stop 1']);
});

test('calling again changes the boundary of a held chat instead of adding a second hold', () => {
  const { k, timers, log } = setup();
  assert.equal(k.hold('a', 'turn_end'), 'held');
  assert.equal(k.hold('a', 'session_idle'), 'replaced');
  assert.equal(timers.size, 1, 'the earlier cap timer is gone');
  k.turnFinished('a');
  assert.equal(k.isHeld('a'), true, 'now it is a session_idle hold');
  assert.deepEqual(log, ['start prevent-app-suspension']);
  // replacing while the idle countdown runs clears that countdown too
  k.hold('a', 'turn_end');
  assert.equal(timers.size, 1);
});

test('a session that ends while a hold is held lets go: stop, crash, deletion, archive and the hold cap', () => {
  for (const end of ['stop', 'crash', 'delete', 'archive', 'cap'] as const) {
    const { k, log, fire } = setup();
    k.hold('a', 'session_idle');
    k.hold('b', 'session_idle');
    if (end === 'delete') k.forget('a');
    else if (end === 'cap') fire(MAX_HOLD_MS);
    else k.release('a');
    assert.equal(k.isHeld('a') && end !== 'cap', false, end);
    if (end === 'cap') assert.equal(k.isHeld('b'), false, 'the cap ends every hold that reached it');
    else assert.equal(k.isHeld('b'), true, `${end}: the other chat still holds`);
    assert.equal(log.filter((l) => l.startsWith('stop')).length, end === 'cap' ? 1 : 0, end);
    k.releaseAll();
    assert.deepEqual(log, ['start prevent-app-suspension', 'stop 1'], end);
  }
});

test('a deleted chat forgets its approval, a stopped one keeps it for the session', () => {
  const { k } = setup();
  k.approved.add('a');
  k.approved.add('b');
  k.hold('a', 'turn_end');
  k.release('a');
  assert.equal(k.approved.has('a'), true);
  k.forget('a');
  assert.equal(k.approved.has('a'), false);
  assert.equal(k.approved.has('b'), true);
});

test('real timers are used by default and a hold can be let go through them', async () => {
  const stops: number[] = [];
  const k = new KeepAwake({ blocker: { start: () => 7, stop: (id: number) => stops.push(id) }, idleMs: 5, maxMs: 10_000 });
  k.hold('a', 'session_idle');
  k.turnFinished('a');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(k.isHeld('a'), false);
  assert.deepEqual(stops, [7]);
});

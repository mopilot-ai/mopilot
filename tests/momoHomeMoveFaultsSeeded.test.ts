// Seeded random fault schedules over two moves of MoMo's home (mulberry32): the same seed always replays the same faults, and every stage must keep one home, a recoverable one, no wipe without a receipt and no turn run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './momoEvals/home/rng.ts';
import { runSeed, schedule } from './momoEvals/home/matrix.ts';

test('mulberry32 and the schedule are pure functions of the seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
  assert.deepEqual(schedule(7), schedule(7));
  assert.notDeepEqual(schedule(7), schedule(8));
  assert.ok(schedule(7).faults.length >= 1 && schedule(7).faults.length <= 3);
});

test('a seed replays: the same faults give the same moves, the same answers and the same frames', async () => {
  const quiet = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((s) => schedule(s).turns.length === 0).slice(0, 2);
  assert.equal(quiet.length, 2);
  for (const seed of quiet) {
    const one = await runSeed(seed);
    const two = await runSeed(seed);
    assert.equal(one.trace, two.trace, `seed ${seed}`);
    assert.deepEqual(one.problems, two.problems);
  }
});

test('forty seeded schedules of one to three faults, turns sent mid-move, skewed clocks and a Cancel keep every invariant through two moves and two recoveries', async () => {
  const problems: string[] = [];
  for (let seed = 1; seed <= 40; seed++) problems.push(...(await runSeed(seed)).problems);
  assert.deepEqual(problems, []);
});

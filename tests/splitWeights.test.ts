// Split view's column sizes (src/session/splitWeights.ts): the room a window has for split panes, the grid's tracks, and
// what a drag or an arrow key on a separator leaves two neighbouring panes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_KEY_STEP, SPLIT_PANE_MIN_WIDTH, dragWeights, gridColumns, keyWeights, splitRoom } from '../src/session/splitWeights.ts';
import { MAX_SPLIT_PANES } from '../src/store/split.ts';

test('splitRoom: split panes beside the primary one at the minimum width, capped by the layout; unmeasured refuses nothing', () => {
  assert.equal(splitRoom(SPLIT_PANE_MIN_WIDTH * 2 - 1), 0, 'one pane only');
  assert.equal(splitRoom(SPLIT_PANE_MIN_WIDTH * 2), 1);
  assert.equal(splitRoom(SPLIT_PANE_MIN_WIDTH * 3 + 10), 2);
  assert.equal(splitRoom(10_000), MAX_SPLIT_PANES);
  for (const w of [0, -5, Number.NaN]) assert.equal(splitRoom(w), MAX_SPLIT_PANES, String(w));
});

test('gridColumns: a share per pane and a 1px separator between two', () => {
  assert.equal(gridColumns([1]), 'minmax(0, 1fr)');
  assert.equal(gridColumns([2, 1, 0.5]), 'minmax(0, 2fr) 1px minmax(0, 1fr) 1px minmax(0, 0.5fr)');
});

/** Weights compared to a billionth, as floating point adds them. */
const near = (actual: number[], expected: number[]) =>
  assert.deepEqual(
    actual.map((x) => Math.round(x * 1e9) / 1e9),
    expected,
  );

test('dragWeights: the two neighbours trade width, the others stay, each kept at the minimum', () => {
  // three equal panes over 1800 px: 600 px each, a weight of 1 is 600 px
  const w = [1, 1, 1];
  const moved = dragWeights(w, 0, 120, 1800);
  near(moved, [1.2, 0.8, 1]);
  near([moved.reduce((a, x) => a + x, 0)], [3]);
  // as far as the right pane's minimum (360 px = 0.6), no further
  near(dragWeights(w, 0, 1000, 1800), [1.4, 0.6, 1]);
  near(dragWeights(w, 1, -1000, 1800), [1, 0.6, 1.4]);
  // a pair too narrow for two minimums splits evenly at most
  near(dragWeights([1.5, 0.5], 0, -500, 600), [1, 1]);
});

test('dragWeights: nothing to move returns the same array', () => {
  const w = [1, 1];
  for (const [at, delta, total] of [
    [0, 0, 1000],
    [0, Number.NaN, 1000],
    [0, 50, 0],
    [1, 50, 1000],
    [-1, 50, 1000],
  ] as const)
    assert.equal(dragWeights(w, at, delta, total), w, `${at} ${delta} ${total}`);
  // already at the minimum, pushed further
  const atMin = dragWeights([1, 1, 1], 0, 1000, 1800);
  assert.equal(dragWeights(atMin, 0, 200, 1800), atMin);
  const even = [1, 1];
  assert.equal(dragWeights(even, 0, 500, 600), even, 'a pair too narrow for two minimums, split evenly');
});

test('keyWeights: Left narrows the left pane by one step, Right widens it; other keys are not the separator’s', () => {
  const w = [1, 1];
  const step = (SPLIT_KEY_STEP * 2) / 1200;
  near(keyWeights(w, 0, 'ArrowRight', 1200)!, [1 + step, 1 - step]);
  near(keyWeights(w, 0, 'ArrowLeft', 1200)!, [1 - step, 1 + step]);
  assert.equal(keyWeights(w, 0, 'ArrowUp', 1200), null);
  assert.equal(keyWeights(w, 0, 'Enter', 1200), null);
});

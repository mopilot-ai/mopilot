// Split view's column sizes: how many split panes the main area has room for, the grid's tracks, and the weights a drag
// or an arrow key on the separator between two panes leaves them.

import { MAX_SPLIT_PANES } from '../store/split';

/** No split view pane (nor the primary one beside them) gets narrower than this while the window has room. */
export const SPLIT_PANE_MIN_WIDTH = 360;
/** How far one arrow key press moves a separator, in pixels. */
export const SPLIT_KEY_STEP = 24;

/**
 * The split panes a main area `width` px wide has room for beside the primary pane, each at least the minimum width. An
 * unmeasured area (zero, negative or not a number) refuses nothing: the layout itself caps the count.
 */
export function splitRoom(width: number): number {
  if (!(width > 0)) return MAX_SPLIT_PANES;
  return Math.max(0, Math.min(MAX_SPLIT_PANES, Math.floor(width / SPLIT_PANE_MIN_WIDTH) - 1));
}

/** The grid's columns: each pane its share of the width (never below zero), a 1 px separator between two. */
export const gridColumns = (weights: number[]) => weights.map((w) => `minmax(0, ${w}fr)`).join(' 1px ');

/**
 * The weights after the separator between pane `at` and pane `at + 1` moved `delta` px across a main area `total` px
 * wide: the two panes trade width, each kept at the minimum width when the pair has room for it, and the rest stay.
 * Returns the same array when nothing moves.
 */
export function dragWeights(weights: number[], at: number, delta: number, total: number): number[] {
  const left = weights[at];
  const right = weights[at + 1];
  if (left === undefined || right === undefined || !(total > 0) || !Number.isFinite(delta) || delta === 0) return weights;
  const sum = weights.reduce((a, w) => a + w, 0);
  const pair = left + right;
  // the minimum as a weight; a pair too narrow for two minimums splits evenly at most
  const min = Math.min((sum * SPLIT_PANE_MIN_WIDTH) / total, pair / 2);
  const next = Math.min(pair - min, Math.max(min, left + (sum * delta) / total));
  // a move smaller than rounding (a separator pushed against a minimum) is no move
  if (Math.abs(next - left) < 1e-9) return weights;
  const out = weights.slice();
  out[at] = next;
  out[at + 1] = pair - next;
  return out;
}

/** The weights after an arrow key on that separator (Left narrows the left pane, Right widens it); null for other keys. */
export function keyWeights(weights: number[], at: number, key: string, total: number): number[] | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return dragWeights(weights, at, key === 'ArrowLeft' ? -SPLIT_KEY_STEP : SPLIT_KEY_STEP, total);
}

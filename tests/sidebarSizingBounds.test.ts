// src/lib/sidebarSizing.ts: one set of sizing functions for every resizable column; the app's sidebar keeps its limits and keys, MoMo's rail and side pane take the design's (#4926).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANE_BOUNDS,
  RAIL_BOUNDS,
  SIDEBAR_BOUNDS,
  finishSidebarResize,
  sidebarDragWidth,
  sidebarKeyWidth,
  sidebarMaxWidth,
} from '../src/lib/sidebarSizing.ts';

test('the sidebar keeps its limits: 200 to 560, Home and an arrow at the minimum hide it, an arrow opens it', () => {
  assert.equal(sidebarMaxWidth(2000), 560);
  assert.equal(sidebarKeyWidth('Home', 300, 2000), 0);
  assert.equal(sidebarKeyWidth('ArrowLeft', 200, 2000), 0);
  assert.equal(sidebarKeyWidth('ArrowRight', 0, 2000), 200);
  assert.equal(sidebarKeyWidth('ArrowRight', 300, 2000), 310);
  assert.equal(sidebarKeyWidth('ArrowLeft', 205, 2000), 200, 'never a sliver by key');
  assert.equal(sidebarKeyWidth('End', 300, 2000), 560);
  assert.equal(sidebarKeyWidth('x', 300, 2000), null);
  assert.equal(sidebarDragWidth(300, -260, 2000), 0, 'snaps to zero under 48');
  const saved: number[] = [];
  finishSidebarResize(
    90,
    () => {},
    () => saved.push(-1),
    (w) => saved.push(w),
  );
  finishSidebarResize(
    150,
    () => {},
    () => saved.push(-1),
    (w) => saved.push(w),
  );
  assert.deepEqual(saved, [-1, 200]);
});

test('the rail is the design’s: 232 to 420, 8 px, 32 px with Shift, Home and End at the limits, hidden only by a drag', () => {
  assert.equal(sidebarMaxWidth(2000, 0, RAIL_BOUNDS), 420);
  assert.equal(sidebarMaxWidth(600, 0, RAIL_BOUNDS), 232, 'a narrow window never goes under the minimum');
  assert.equal(sidebarKeyWidth('ArrowRight', 288, 2000, 0, RAIL_BOUNDS), 296);
  assert.equal(sidebarKeyWidth('ArrowLeft', 288, 2000, 0, RAIL_BOUNDS, true), 256);
  assert.equal(sidebarKeyWidth('ArrowLeft', 236, 2000, 0, RAIL_BOUNDS), 232);
  assert.equal(sidebarKeyWidth('Home', 300, 2000, 0, RAIL_BOUNDS), 232);
  assert.equal(sidebarKeyWidth('End', 300, 2000, 0, RAIL_BOUNDS), 420);
  assert.equal(sidebarDragWidth(288, -300, 2000, 0, RAIL_BOUNDS), 0);
  const out: string[] = [];
  finishSidebarResize(
    100,
    () => {},
    () => out.push('close'),
    () => out.push('save'),
    RAIL_BOUNDS,
  );
  finishSidebarResize(
    120,
    () => {},
    () => out.push('close'),
    (w) => out.push(`save ${w}`),
    RAIL_BOUNDS,
  );
  assert.deepEqual(out, ['close', 'save 232']);
});

test('the pane is the design’s: 420 to 732, the arrow that moves its left edge grows it', () => {
  assert.equal(sidebarMaxWidth(2000, 288, PANE_BOUNDS), 732);
  assert.equal(sidebarMaxWidth(1000, 288, PANE_BOUNDS), 420);
  assert.equal(sidebarKeyWidth('ArrowLeft', 420, 2000, 288, PANE_BOUNDS, false, 'ArrowLeft'), 428);
  assert.equal(sidebarKeyWidth('ArrowRight', 420, 2000, 288, PANE_BOUNDS, true, 'ArrowLeft'), 420);
  assert.equal(sidebarKeyWidth('ArrowRight', 500, 2000, 288, PANE_BOUNDS, true, 'ArrowLeft'), 468);
  assert.equal(SIDEBAR_BOUNDS.homeHides && !PANE_BOUNDS.homeHides, true);
});

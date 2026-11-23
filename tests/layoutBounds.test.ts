// Rendered-control bounds distinguish legal wrapping and touching edges from real two-dimensional collisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsAreSeparate, type LayoutBounds } from './support/layoutBounds.ts';

const box = (left: number, top: number, right: number, bottom: number): LayoutBounds => ({ left, top, right, bottom });
const first = box(0, 0, 100, 28);

test('empty and single-control layouts have no collisions', () => {
  assert.equal(controlsAreSeparate([]), true);
  assert.equal(controlsAreSeparate([first]), true);
});

test('horizontal and vertical separation work in either order, including touching and fractional edges', () => {
  for (const next of [box(100, 0, 150, 28), box(0, 28, 100, 56), box(50.5, 30.25, 150.5, 58.25)]) {
    assert.equal(controlsAreSeparate([first, next]), true);
    assert.equal(controlsAreSeparate([next, first]), true);
  }
});

test('actual overlaps fail, including later pairs in an otherwise separated layout', () => {
  const overlap = box(99.5, 27.5, 150, 56);
  assert.equal(controlsAreSeparate([first, overlap]), false);
  assert.equal(controlsAreSeparate([overlap, first]), false);
  assert.equal(controlsAreSeparate([box(200, 0, 250, 28), first, overlap]), false);
});

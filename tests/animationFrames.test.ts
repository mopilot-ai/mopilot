// Verifies the browser ordering and retirement contract of the controlled DOM animation-frame clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { animationFrames } from './support/animationFrames.ts';

test('a frame holds newly queued work for the next frame and respects cancellation within its current batch', () => {
  const clock = animationFrames();
  const calls: string[] = [];
  try {
    requestAnimationFrame((at) => {
      calls.push(`paint:${at}`);
      cancelAnimationFrame(cancelled);
      requestAnimationFrame((next) => calls.push(`scroll:${next}`));
    });
    const cancelled = requestAnimationFrame(() => calls.push('cancelled'));
    assert.equal(clock.pending, 2);
    clock.frame(16);
    assert.deepEqual(calls, ['paint:16']);
    assert.equal(clock.pending, 1);
    clock.frame(32);
    assert.deepEqual(calls, ['paint:16', 'scroll:32']);
    assert.equal(clock.pending, 0);
  } finally {
    clock.restore();
  }
});

test('retiring the test clock drops pending work and restores both browser entrypoints', () => {
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const clock = animationFrames();
  let called = false;
  try {
    requestAnimationFrame(() => {
      called = true;
    });
    clock.restore();
    clock.frame();
    assert.equal(called, false);
    assert.equal(clock.pending, 0);
    assert.equal(globalThis.requestAnimationFrame, request);
    assert.equal(globalThis.cancelAnimationFrame, cancel);
  } finally {
    clock.restore();
  }
});

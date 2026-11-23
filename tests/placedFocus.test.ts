// Deferred initial focus respects placement, bounded retries, live ownership and newer keyboard choices.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { focusAfterPlacement } from '../src/lib/placedFocus';

function fixture(t: TestContext) {
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = (id) => {
    cancelled.push(id);
  };
  const trigger = document.createElement('input');
  const panel = document.createElement('div');
  panel.tabIndex = -1;
  document.body.append(trigger, panel);
  trigger.focus();
  let next = 0;
  const step = () => frames[next++](0);
  t.after(() => {
    trigger.remove();
    panel.remove();
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
  });
  return { trigger, panel, frames, cancelled, step };
}

test('focus waits for placement, retries a hidden layer and stops once it lands', (t) => {
  const f = fixture(t);
  const realFocus = f.panel.focus.bind(f.panel);
  f.panel.focus = () => {};
  const cancel = focusAfterPlacement(f.panel);
  assert.equal(document.activeElement, f.trigger);
  f.step();
  assert.equal(f.frames.length, 2);
  f.panel.focus = realFocus;
  f.step();
  assert.equal(document.activeElement, f.panel);
  assert.equal(f.frames.length, 2);
  cancel();
  assert.deepEqual(f.cancelled, [2]);
});

test('a layer that never accepts focus stops after ten attempts', (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.panel.focus = () => {
    attempts++;
  };
  const cancel = focusAfterPlacement(f.panel);
  for (let i = 0; i < 10; i++) f.step();
  assert.equal(attempts, 10);
  assert.equal(f.frames.length, 10);
  assert.equal(document.activeElement, f.trigger);
  cancel();
});

test('a cancelled callback cannot take focus even if it was already queued', (t) => {
  const f = fixture(t);
  const cancel = focusAfterPlacement(f.panel);
  cancel();
  f.step();
  assert.equal(document.activeElement, f.trigger);
  assert.deepEqual(f.cancelled, [1]);
});

test('a disconnected layer cannot take focus', (t) => {
  const f = fixture(t);
  const cancel = focusAfterPlacement(f.panel);
  f.panel.remove();
  f.step();
  assert.equal(document.activeElement, f.trigger);
  assert.equal(f.frames.length, 1);
  cancel();
});

test('a newer focus choice wins over a pending retry', (t) => {
  const f = fixture(t);
  const realFocus = f.panel.focus.bind(f.panel);
  f.panel.focus = () => {};
  const cancel = focusAfterPlacement(f.panel);
  f.step();
  const newer = document.createElement('input');
  f.panel.append(newer);
  newer.focus();
  f.panel.focus = realFocus;
  f.step();
  assert.equal(document.activeElement, newer);
  assert.equal(f.frames.length, 2);
  cancel();
});

test('a layer already containing focus keeps its focused descendant', (t) => {
  const f = fixture(t);
  const child = document.createElement('input');
  f.panel.append(child);
  child.focus();
  const cancel = focusAfterPlacement(f.panel);
  f.step();
  assert.equal(document.activeElement, child);
  assert.equal(f.frames.length, 1);
  cancel();
});

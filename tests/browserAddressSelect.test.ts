// Focusing the browser's address bar selects its text on the next frame, but never over typing that frame came after: a
// late frame (an unpainted window) selected what the user had started typing, so the next key replaced it (#3148).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, change, clearRoot, input, setup } from './support/browser-panel-ui/fixture';

const raf = globalThis.requestAnimationFrame;
let frames: Function[] = [];
const holdFrames = () => {
  frames = [];
  (globalThis as any).requestAnimationFrame = (fn: Function) => frames.push(fn);
};
const runFrames = () =>
  act(async () => {
    const due = frames;
    frames = [];
    for (const fn of due) fn(0);
  });
afterEach(async () => {
  globalThis.requestAnimationFrame = raf;
  await clearRoot();
});

const focus = (el: HTMLInputElement) => act(async () => void el.focus());
const selected = (el: HTMLInputElement) => [el.selectionStart, el.selectionEnd];

test('focusing the address bar selects its whole text on the next frame', async () => {
  await setup();
  holdFrames();
  const el = input();
  await focus(el);
  await runFrames();
  assert.ok(el.value.length > 0);
  assert.deepEqual(selected(el), [0, el.value.length]);
});

test('text typed before that frame runs is not selected by it', async () => {
  await setup();
  holdFrames();
  const el = input();
  await focus(el);
  await change('.browser-addr input', 'exam');
  el.setSelectionRange(4, 4);
  await runFrames();
  assert.equal(el.value, 'exam');
  assert.deepEqual(selected(el), [4, 4], 'the late frame must not select the typed text');
});

test('a composition started before that frame runs is not selected over either', async () => {
  await setup();
  holdFrames();
  const el = input();
  await focus(el);
  await act(async () => void el.dispatchEvent(new (globalThis as any).window.CompositionEvent('compositionstart', { bubbles: true })));
  el.setSelectionRange(2, 2);
  await runFrames();
  assert.deepEqual(selected(el), [2, 2]);
});

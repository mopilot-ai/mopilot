// Restoring a draft puts the caret at its end on the next frame, but never over text typed before that frame ran: a late
// frame (an unpainted window) moved the caret of a "/plan" typed in front of a draft to its end (#3148).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window } from './support/dom.ts';
import { mountComposer, reset, store } from './support/composer-setup.ts';

let frames: FrameRequestCallback[] = [];
const raf = globalThis.requestAnimationFrame;
beforeEach(() => {
  reset();
  frames = [];
  // frames wait until the test runs them, as in a window the OS has not painted yet
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
});
afterEach(() => {
  globalThis.requestAnimationFrame = raf;
});

const runFrames = () =>
  act(async () => {
    const due = frames;
    frames = [];
    for (const cb of due) cb(0);
  });

/** The caret's offset in the editor's text, or null when the selection is elsewhere. */
function caret(editor: Element): number | null {
  const sel = window.getSelection()!;
  if (!sel.rangeCount || !editor.contains(sel.anchorNode as any)) return null;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(sel.anchorNode as unknown as Node, sel.anchorOffset);
  return range.toString().length;
}

test('a restored draft takes the caret at its end on the next frame', async () => {
  store.set({ drafts: { home: { text: 'saved draft', attachments: [] } } });
  const m = await mountComposer({ threadId: null });
  try {
    await runFrames();
    assert.equal(m.text, 'saved draft');
    assert.equal(document.activeElement, m.editor());
    assert.equal(caret(m.editor()), 'saved draft'.length);
  } finally {
    await m.unmount();
  }
});

test('typing in front of the draft before that frame runs keeps the caret where the typing left it', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    // the draft, then "/" typed at its start, both before the restore's frame runs
    await m.type('/fix the login bug', 1);
    assert.equal(caret(m.editor()), 1);
    await runFrames();
    assert.equal(m.text, '/fix the login bug');
    assert.equal(caret(m.editor()), 1, 'the late frame must not move the caret to the end');
  } finally {
    await m.unmount();
  }
});

test('a key pressed in the box before that frame runs (Home, an arrow) also keeps the caret where it is', async () => {
  store.set({ drafts: { home: { text: 'fix the login bug', attachments: [] } } });
  const m = await mountComposer({ threadId: null });
  try {
    const range = document.createRange();
    range.setStart(m.editor().firstChild, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    await m.key('Home');
    await runFrames();
    assert.equal(caret(m.editor()), 0);
  } finally {
    await m.unmount();
  }
});

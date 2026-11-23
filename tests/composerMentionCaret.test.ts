// Keystrokes typed right after an @ pick (Composer applyMention, applyChatMention, applyTabMention; the / command pick) land after the inserted text, not at the caret the query left (#1719): the editor's own replaceRange places the caret in the same step, with no frame in between.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mouse } from './support/composer-kit.ts';
import { fx, mountComposer, reset, setSessionState, settle, store } from './support/composer-setup.ts';
import { act } from 'react';

const W = window as any;
// Frames run only when a test says so: in the app the next keydown can be handled before the next frame, while the
// DOM shim's requestAnimationFrame is a timer that act() would run before the next key
let frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
beforeEach(() => {
  reset();
  frames = [];
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
});
/** The next frame: every callback queued so far. */
const nextFrame = () =>
  act(async () => {
    const due = frames;
    frames = [];
    for (const cb of due) cb(0);
  });

type Mounted = Awaited<ReturnType<typeof mountComposer>>;
/** The user is typing in the composer: the editor has focus (a focused editor keeps its caret offset when its text is replaced). */
async function focused() {
  const m = await mountComposer({ threadId: null });
  await act(async () => m.editor().focus());
  return m;
}
/** A mouse pick of the first @ row (rows pick on mousedown, so the editor keeps focus). */
const pickWithMouse = () =>
  act(async () => void $('.composer-popup .menu-item').dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true })));
/** A keystroke's worth of text inserted where the editor's caret is now, before any timer or frame runs (as a fast typist's next key). */
const typeAtCaret = (m: Mounted, s: string) =>
  act(async () => {
    const sel = window.getSelection()!;
    const range = sel.getRangeAt(0);
    const node = document.createTextNode(s);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    m.editor().dispatchEvent(new W.InputEvent('input', { bubbles: true }));
  });

for (const how of ['Enter', 'click'] as const) {
  test(`text typed right after an @ file is picked with ${how} goes after the mention`, async () => {
    fx.files = [{ path: '/home/src/parser.ts', file_name: 'parser.ts', indices: null }];
    const m = await focused();
    try {
      await m.type('read @parser');
      await settle(130);
      assert.ok($('.composer-popup .menu-item'), 'the @ list shows the file');
      if (how === 'Enter') await m.key('Enter');
      else await pickWithMouse();
      // no settle: the next key comes before any frame
      await typeAtCaret(m, 'and the spec');
      await nextFrame();
      assert.equal(m.text, 'read @/home/src/parser.ts and the spec');
    } finally {
      await m.unmount();
    }
  });
}

test('a folder picked with @ keeps its trailing slash, and the next keys follow it', async () => {
  fx.files = [{ path: '/home/docs', file_name: 'docs', indices: null, match_type: 'directory' }];
  const m = await focused();
  try {
    await m.type('see @doc');
    await settle(130);
    await m.key('Enter');
    await typeAtCaret(m, 'now');
    await nextFrame();
    assert.equal(m.text, 'see @/home/docs/ now');
  } finally {
    await m.unmount();
  }
});

test('a mention picked in the middle of the text keeps the text after it, and the caret lands after the mention', async () => {
  fx.files = [{ path: '/home/a.ts', file_name: 'a.ts', indices: null }];
  const m = await focused();
  try {
    await m.type('see @a then more', 'see @a'.length);
    await settle(130);
    await m.key('Enter');
    await typeAtCaret(m, 'X');
    await nextFrame();
    assert.equal(m.text, 'see @/home/a.ts X then more');
  } finally {
    await m.unmount();
  }
});

test("a basic harness's typed / command: keys typed right after the pick follow it", async () => {
  store.set({ basicOf: { t1: 'kimi' } });
  setSessionState('t1', { acp: { commands: [] } });
  fx.acpRegistry = { menu: [{ name: 'web', description: 'Search the web', dispatch: 'passthrough' }] };
  const m = await mountComposer({ threadId: 't1' });
  await act(async () => m.editor().focus());
  try {
    await m.type('/we');
    await settle();
    await mouse($('.slash-panel .add-panel-item'), 'mousedown');
    await typeAtCaret(m, 'cats');
    await nextFrame();
    assert.equal(m.text, '/web cats');
  } finally {
    await m.unmount();
  }
});

test('setCaretAfter places the caret at once when the editor already shows that text, and ignores a text it never draws', async () => {
  const m = await focused();
  try {
    await m.type('hello world');
    await act(async () => m.editor().setCaretAfter('hello world', 5));
    assert.equal(m.editor().selectionStart, 5);
    await typeAtCaret(m, ',');
    assert.equal(m.text, 'hello, world');
    // asked for a text the next render does not draw: the redraw keeps the focused editor's own caret
    await act(async () => m.editor().setCaretAfter('something else', 0));
    await m.type('typed again');
    assert.equal(m.editor().selectionStart, 'typed again'.length);
  } finally {
    await m.unmount();
  }
});

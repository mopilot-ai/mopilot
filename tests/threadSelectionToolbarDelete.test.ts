// Deleting an annotation from the comment bar over its quoted text, as Codex's comment editor deletes one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, createRef } from 'react';
import { mockStore, autoMock, render, settle, setStore, useStore, impl, window } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/ui/Dictation.tsx', 'dictation', { Dictation: () => null });
const { SelectionToolbar } = await import('../src/components/thread/SelectionToolbar.tsx');

(globalThis as any).DOMRect = window.DOMRect;
const frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb) => frames.push(cb);
globalThis.cancelAnimationFrame = () => {};
const flush = () =>
  settle(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
const rect = (left: number, top: number, width: number, height: number) => new window.DOMRect(left, top, width, height);

const container = document.createElement('div');
const body = document.createElement('div');
body.className = 'user-bubble';
const textNode = document.createTextNode('selected words');
body.append(textNode);
container.append(body);
document.body.append(container);
container.getBoundingClientRect = () => rect(0, 0, 800, 600) as any;
const ref = createRef<HTMLElement>() as any;
ref.current = container;

let selection: any = null;
Object.defineProperty(window, 'getSelection', { configurable: true, value: () => selection });
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
function select(text: string) {
  const range: any = {
    getClientRects: () => [rect(100, 200, 200, 20)],
    cloneRange: () => range,
    commonAncestorContainer: textNode,
    startContainer: textNode,
    startOffset: 0,
    endContainer: textNode,
    endOffset: 0,
  };
  selection = { isCollapsed: false, rangeCount: 1, toString: () => text, getRangeAt: () => range, removeAllRanges: () => {} };
}
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as
    | HTMLElement
    | undefined;

test('the comment bar deletes its annotation from the composer and its draft, and does not bring it back', async () => {
  impl['store:setDraft'] = (id: string, draft: unknown) => setStore((s: any) => ({ drafts: { ...s.drafts, [id]: draft } }));
  const removed: any[] = [];
  const onRemove = (e: any) => removed.push(e.detail);
  window.addEventListener('composer-remove-selection', onRemove);
  const v = await render(h(SelectionToolbar, { containerRef: ref, threadId: 't' }));
  try {
    select('selected words');
    await settle(() => document.dispatchEvent(new window.Event('selectionchange') as any));
    await flush();
    await settle(() => button('Reply')!.click());
    await flush();
    const [attachment] = useStore.getState().drafts.t.attachments;
    assert.ok(document.querySelector('.annotation-comment-input'));
    assert.ok(document.querySelector('.annotation-marker'), 'the new annotation is numbered');
    selection = null;
    await settle(() => button('Delete annotation')!.click());
    await flush();
    assert.deepEqual(removed, [{ threadId: 't', annotationId: attachment.annotationId }]);
    assert.deepEqual(useStore.getState().drafts.t.attachments, []);
    assert.equal(document.querySelector('.annotation-comment-input'), null, 'the bar closes');
    assert.equal(document.querySelector('.annotation-marker'), null, 'its number goes with it');
  } finally {
    window.removeEventListener('composer-remove-selection', onRemove);
    delete impl['store:setDraft'];
    await v.unmount();
  }
});

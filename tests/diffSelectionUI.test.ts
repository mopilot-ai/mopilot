// Selected-code comments: column/range boundaries, geometry, keyboard/pointer entry and retirement on context changes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { autoMock, render, window } from './support/thread-kit.ts';
import type { DiffCell } from '../src/components/diff/DiffComments.tsx';

autoMock('src/components/markdown/Markdown.tsx', 'md', { useResolvedDark: () => true });
autoMock('src/lib/highlight.ts', 'hl', { langFromPath: () => 'text' });
autoMock('src/session/open.ts', 'open');
autoMock('src/session/clipboard.ts', 'clip');
const { InlineDiff, SplitDiff, parseUnifiedDiff } = await import('../src/components/diff/DiffView.tsx');
const { readDiffSelection } = await import('../src/components/diff/DiffCommentSurface.tsx');
const file = parseUnifiedDiff('--- a/s.txt\n+++ b/s.txt\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail')[0];
const commenting = { chatId: 'chat-a', path: 's.txt', workspace: '/repo', onAdd() {} };
const plus = () => document.querySelector<HTMLButtonElement>('.diff-selection-add');
const fire = (target: EventTarget, event: Event) => act(() => target.dispatchEvent(event));

beforeEach(async () => {
  await act(() => window.getSelection()!.removeAllRanges());
});

async function select(start: Node, end = start, startOffset = 0, endOffset = end.childNodes.length) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  await act(() => {
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    document.dispatchEvent(new window.Event('selectionchange') as any);
  });
}

test('split selections comment on their own old/new column and reject cross-column or external text', async (t) => {
  const v = await render(h(SplitDiff, { file, commenting }));
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  t.mock.method(window.Range.prototype, 'getClientRects', function (this: Range) {
    const end = this.endContainer instanceof Element ? this.endContainer : this.endContainer.parentElement;
    return [new window.DOMRect(end?.closest('[data-diff-col="1"]') ? 400 : 200, 160, 90, 20)] as any;
  });
  for (const row of v.$$('.split-row')) {
    (row.children[0] as HTMLElement).getBoundingClientRect = () => new window.DOMRect(100, 100, 250, 300) as any;
    (row.children[1] as HTMLElement).getBoundingClientRect = () => new window.DOMRect(350, 100, 250, 300) as any;
  }
  const left = v.$$('[data-diff-col="0"]');
  const right = v.$$('[data-diff-col="1"]');
  await select(left[0], left[1]);
  assert.ok(plus());
  await act(() => plus()!.click());
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 3-4');
  assert.deepEqual(
    v.$$('.commenting .idiff-ln').map((el) => el.textContent),
    ['3', '4'],
  );
  await select(right[1]);
  assert.equal(plus(), null, 'an open editor does not offer a second selection action');
  await fire(v.$('textarea')!, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
  await select(right[1], right[2]);
  await act(() => plus()!.click());
  assert.deepEqual(v.$$('.split-row').filter((row) => row.children[1].classList.contains('commenting')).length, 2);
  await fire(v.$('textarea')!, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
  await select(left[0], right[1]);
  assert.equal(plus(), null);
  const outside = document.createElement('span');
  outside.textContent = 'outside code';
  v.host.append(outside);
  await select(left[0], outside);
  assert.equal(plus(), null);
  await select(v.$('.idiff-ln')!);
  assert.equal(plus(), null, 'gutter text is not code');
  const unpaired = { ...file, lines: [...file.lines, { kind: 'add' as const, newNo: 6, text: 'extra' }] };
  await v.rerender(h(SplitDiff, { file: unpaired, commenting }));
  assert.equal(v.$$('.split-row').at(-1)!.children[0].querySelector('.idiff-code')!.textContent, '');
});

test('split text clipped at the column boundary keeps its plus in the selected column', async (t) => {
  const v = await render(h(SplitDiff, { file, commenting }));
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  const left = v.$('.split-row')!.children[0] as HTMLElement;
  left.getBoundingClientRect = () => new window.DOMRect(100, 100, 250, 300) as any;
  let rect = new window.DOMRect(200, 160, 400, 20);
  t.mock.method(window.Range.prototype, 'getClientRects', () => [rect] as any);
  await select(left.querySelector('.idiff-code')!);
  assert.equal(plus()!.style.left, '322px');
  rect = new window.DOMRect(360, 160, 200, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null, 'fully clipped glyphs cannot offer a visible action');
});

test('the plus follows geometry, hides during a pointer drag and outside the viewport, and Escape dismisses it', async (t) => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  let rects = [new window.DOMRect(200, 160, 90, 20)];
  t.mock.method(window.Range.prototype, 'getClientRects', () => rects as any);
  const code = v.$('.idiff-code')!;
  await select(code);
  const initial = plus();
  assert.equal(initial!.style.left, '296px');
  await fire(window as any, new window.Event('resize') as any);
  assert.equal(plus(), initial, 'unchanged geometry keeps the same action');
  await fire(code, new window.PointerEvent('pointerdown', { bubbles: true }) as any);
  assert.equal(plus(), null);
  await v.rerender(h(InlineDiff, { file: { ...file }, bare: true, commenting }));
  assert.equal(plus(), null, 'a same-code refresh must not retire an ongoing pointer drag');
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal(plus(), null);
  await fire(window as any, new window.PointerEvent('pointerup') as any);
  assert.ok(plus());
  await fire(code, new window.PointerEvent('pointerdown', { bubbles: true }) as any);
  await fire(window as any, new window.PointerEvent('pointercancel') as any);
  assert.ok(plus());
  rects = [new window.DOMRect(580, 390, 30, 20)];
  await fire(window as any, new window.Event('scroll') as any);
  assert.deepEqual([plus()!.style.left, plus()!.style.top], ['572px', '376px']);
  rects = [new window.DOMRect(200, 900, 30, 20)];
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null);
  rects = [new window.DOMRect(200, 160, 90, 20)];
  await fire(window as any, new window.Event('resize') as any);
  await fire(window as any, new window.KeyboardEvent('keydown', { key: 'ArrowLeft' }) as any);
  assert.ok(plus());
  await fire(window as any, new window.KeyboardEvent('keydown', { key: 'Escape' }) as any);
  assert.equal(plus(), null);
  assert.equal(window.getSelection()!.isCollapsed, true);
  await select(code);
  const stale = plus()!;
  await act(() => {
    window.getSelection()!.removeAllRanges();
    stale.click();
  });
  assert.equal(v.$('textarea'), null, 'a stale action cannot comment on a cleared range');
});

test('the plus stays inside the outer Changes viewport and below the sticky file header', async (t) => {
  const v = await render(
    h(
      'div',
      { className: 'cp-diffs' },
      h(
        'section',
        { className: 'cp-file' },
        h('div', { className: 'cp-file-head' }, 's.txt'),
        h(InlineDiff, { file, bare: true, commenting }),
      ),
    ),
  );
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(0, 0, 900, 1000) as any;
  v.$('.cp-diffs')!.getBoundingClientRect = () => new window.DOMRect(100, 200, 500, 200) as any;
  v.$('.cp-file-head')!.getBoundingClientRect = () => new window.DOMRect(100, 200, 500, 38) as any;
  let rect = new window.DOMRect(200, 180, 90, 20);
  t.mock.method(window.Range.prototype, 'getClientRects', () => [rect] as any);
  await select(v.$('.idiff-code')!);
  assert.equal(plus(), null, 'code above the scrolling viewport must not put an action over the toolbar');
  rect = new window.DOMRect(200, 215, 90, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null, 'the sticky file header hides the code underneath');
  rect = new window.DOMRect(200, 250, 90, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus()!.style.top, '248px');
  rect = new window.DOMRect(20, 250, 40, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null);
});

test('chat, workspace, file and revision changes retire selection and editor state; a new selection still works', async (t) => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  t.mock.method(window.Range.prototype, 'getClientRects', () => [new window.DOMRect(200, 160, 90, 20)] as any);
  let config = commenting;
  for (const patch of [{ chatId: 'claude:b' }, { workspace: '/other' }, { path: 'other.txt' }]) {
    await select(v.$('.idiff-code')!);
    assert.ok(plus());
    config = { ...config, ...patch };
    await v.rerender(h(InlineDiff, { file, bare: true, commenting: config }));
    assert.equal(plus(), null, 'identical text in another context does not inherit the old selection');
    assert.equal(window.getSelection()!.isCollapsed, true);
    await select(v.$('.idiff-code')!);
    await act(() => plus()!.click());
    assert.ok(v.$('textarea'));
    config = { ...config, chatId: `${config.chatId}:next` };
    await v.rerender(h(InlineDiff, { file, bare: true, commenting: config }));
    assert.equal(v.$('textarea'), null);
  }
  await select(v.$('.idiff-code')!);
  const revised = { ...file, lines: file.lines.map((line) => ({ ...line, text: `${line.text} edited` })) };
  await v.rerender(h(InlineDiff, { file: revised, bare: true, commenting: config }));
  assert.equal(plus(), null);
  await select(v.$('.idiff-code')!);
  assert.ok(plus());
  await v.rerender(h(InlineDiff, { file: revised, bare: true }));
  assert.equal(plus(), null);
  await v.unmount();
  await fire(document, new window.Event('selectionchange') as any);
  await fire(window as any, new window.Event('resize') as any);
  assert.equal(plus(), null);
});

test('range boundaries exclude an unselected adjacent line and skip invalid or invisible DOM ranges', async (t) => {
  const root = document.createElement('div');
  root.innerHTML =
    '<span data-diff-row="0" data-diff-col="0">first</span><span data-diff-row="1" data-diff-col="0">second</span><span data-diff-row="2" data-diff-col="0">third</span>';
  document.body.append(root);
  t.after(() => root.remove());
  root.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  let rects = [new window.DOMRect(200, 160, 90, 20)];
  t.mock.method(window.Range.prototype, 'getClientRects', () => rects as any);
  const columns: (DiffCell | undefined)[][] = [[0, 1, 2].map((line) => ({ side: 'R', line, sign: ' ', text: 'code' }))];
  const read = () => readDiffSelection(root as any, columns);
  const [first, second, third] = Array.from(root.children);
  await select(first.firstChild!, third.firstChild!, 5, 0);
  assert.deepEqual([read()!.anchor, read()!.head], [1, 1]);
  await select(first, second);
  assert.deepEqual([read()!.anchor, read()!.head], [0, 1]);
  for (const rect of [
    new window.DOMRect(1, 160, 20, 20),
    new window.DOMRect(600, 160, 20, 20),
    new window.DOMRect(200, 1, 20, 20),
    new window.DOMRect(200, 400, 20, 20),
    new window.DOMRect(200, 160, 0, 20),
    new window.DOMRect(200, 160, 20, 0),
  ]) {
    rects = [rect];
    assert.equal(read(), null);
  }
  rects = [];
  assert.equal(read(), null);
  first.setAttribute('data-diff-col', '9');
  assert.equal(read(), null);
  first.setAttribute('data-diff-col', '0');
  first.setAttribute('data-diff-row', '9');
  assert.equal(read(), null);
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode('detached'));
  await select(fragment);
  assert.equal(read(), null);
  const get = t.mock.method(window, 'getSelection', () => null);
  assert.equal(read(), null);
  get.mock.restore();
});

test('off-screen selections retire on owner changes and Escape even while no plus is visible', async (t) => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  t.after(() => v.unmount());
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  let rect = new window.DOMRect(200, 160, 90, 20);
  t.mock.method(window.Range.prototype, 'getClientRects', () => [rect] as any);
  await select(v.$('.idiff-code')!);
  assert.ok(plus());
  rect = new window.DOMRect(200, 900, 90, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null);
  await v.rerender(h(InlineDiff, { file, bare: true, commenting: { ...commenting, chatId: 'other' } }));
  assert.equal(window.getSelection()!.isCollapsed, true);
  rect = new window.DOMRect(200, 160, 90, 20);
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(plus(), null);
  await select(v.$('.idiff-code')!);
  rect = new window.DOMRect(200, 900, 90, 20);
  await fire(window as any, new window.Event('scroll') as any);
  await fire(window as any, new window.KeyboardEvent('keydown', { key: 'Escape' }) as any);
  assert.equal(window.getSelection()!.isCollapsed, true);
});

test('a parent rendering again does not re-subscribe the selection listeners; a selection reads the latest lines (#2049)', async (t) => {
  const subscribed = () => added.filter((type) => type === 'selectionchange').length;
  const added: string[] = [];
  const real = document.addEventListener.bind(document);
  t.mock.method(document, 'addEventListener', (type: string, ...rest: any[]) => {
    added.push(type);
    return (real as any)(type, ...rest);
  });
  // the Changes pane hands each file a new notes array on every render, as a drag or a poll renders it again
  const v = await render(h(InlineDiff, { file, commenting, notes: [] }));
  t.after(() => v.unmount());
  assert.equal(subscribed(), 1);
  await v.rerender(h(InlineDiff, { file, commenting, notes: [] }));
  await v.rerender(h(SplitDiff, { file, commenting, notes: [] }));
  const split = subscribed();
  await v.rerender(h(SplitDiff, { file, commenting, notes: [] }));
  assert.equal(subscribed(), split, 'a split diff rendered again keeps its listeners too');
  // the same file revision with new lines objects: the listener in place reads the new columns
  const same = parseUnifiedDiff('--- a/s.txt\n+++ b/s.txt\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail')[0];
  await v.rerender(h(SplitDiff, { file: same, commenting, notes: [] }));
  assert.equal(subscribed(), split, 'the same revision read again keeps its listeners, which read its new lines');
  v.$('.idiff-body')!.getBoundingClientRect = () => new window.DOMRect(100, 100, 500, 300) as any;
  t.mock.method(window.Range.prototype, 'getClientRects', () => [new window.DOMRect(400, 160, 90, 20)] as any);
  for (const row of v.$$('.split-row')) {
    (row.children[0] as HTMLElement).getBoundingClientRect = () => new window.DOMRect(100, 100, 250, 300) as any;
    (row.children[1] as HTMLElement).getBoundingClientRect = () => new window.DOMRect(350, 100, 250, 300) as any;
  }
  await select(v.$$('[data-diff-col="1"]')[1]);
  assert.ok(plus(), 'the plus shows for a selection in the re-rendered diff');
  await act(() => plus()!.click());
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Line 4');
});

// Commenting on diff lines in the inline and side-by-side diffs: picking a line or a dragged range, the comment box and its keys.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { act } from 'react';
import { autoMock, render, moduleCalls, window } from './support/thread-kit.ts';

autoMock('src/components/markdown/Markdown.tsx', 'md', { useResolvedDark: () => true });
autoMock('src/lib/highlight.ts', 'hl', { langFromPath: () => 'text' });
autoMock('src/session/open.ts', 'open');
autoMock('src/session/clipboard.ts', 'clip');
const { InlineDiff, SplitDiff, parseUnifiedDiff } = await import('../src/components/diff/DiffView.tsx');
const { commentRange, PendingDiffComment, rangeLabel, linesLabel } = await import('../src/components/diff/DiffComments.tsx');

const file = parseUnifiedDiff('--- a/s.txt\n+++ b/s.txt\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail')[0];
let added: [any, string][] = [];
const commenting = { path: 's.txt', workspace: '/repo', onAdd: (range: any, comment: string) => added.push([range, comment]) };
beforeEach(async () => {
  added = [];
  moduleCalls.length = 0;
  await act(() => window.getSelection()!.removeAllRanges());
});

const mouse = (el: Element, type: string, init: Record<string, unknown> = {}) =>
  act(async () => {
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init }) as any);
  });
const typeComment = (v: { $: (s: string) => HTMLElement | null }, text: string) =>
  act(() => {
    const box = v.$('textarea')!;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
const keyIn = (el: Element, key: string, extra = {}) =>
  act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }) as any);
  });
const picked = (v: { $$: (s: string) => HTMLElement[] }) => v.$$('.idiff-row.commenting .idiff-ln').map((el) => el.textContent);

test('selected code offers a nearby plus that preserves the selection and comments on the selected lines', async (t) => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  t.after(() => v.unmount());
  const bounds = new window.DOMRect(100, 100, 500, 300);
  v.$('.idiff-body')!.getBoundingClientRect = () => bounds as any;
  t.mock.method(window.Range.prototype, 'getClientRects', () => [new window.DOMRect(200, 160, 90, 20)] as any);
  const codes = v.$$('.idiff-code');
  const range = document.createRange();
  range.setStart(codes[2], 0);
  range.setEnd(codes[3], codes[3].childNodes.length);
  const selection = window.getSelection()!;
  selection.addRange(range as any);
  await act(() => document.dispatchEvent(new window.Event('selectionchange') as any));
  const plus = document.querySelector<HTMLButtonElement>('.diff-selection-add');
  assert.ok(plus, 'selected code should offer an adjacent +');
  assert.equal(plus.style.left, '296px');
  assert.equal(plus.getAttribute('aria-label'), 'Comment on selected lines');
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await act(() => plus.dispatchEvent(down as any));
  assert.equal(down.defaultPrevented, true);
  assert.equal(selection.isCollapsed, false);
  await act(() => plus.click());
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 4-5');
  assert.equal(document.querySelector('.diff-selection-add'), null);
  await typeComment(v, 'selected feedback');
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added, [
    [
      {
        path: 's.txt',
        workspace: '/repo',
        startSide: 'R',
        startLine: 4,
        endSide: 'R',
        endLine: 5,
        hunk: '+new\n tail',
      },
      'selected feedback',
    ],
  ]);
});

test('without commenting a diff has no add buttons', async () => {
  const v = await render(h(InlineDiff, { file, bare: true }));
  assert.equal(v.$$('.diff-comment-add').length, 0);
  await v.unmount();
});

test('inline: a click comments on one line; Enter adds the trimmed comment and closes the box', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  const buttons = v.$$('.diff-comment-add');
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-label')),
    ['Comment on line 3', 'Comment on line L4', 'Comment on line 4', 'Comment on line 5'],
  );
  await mouse(buttons[2], 'mousedown');
  assert.equal(v.$('textarea'), null);
  await mouse(window as any, 'mouseup');
  assert.deepEqual(picked(v), ['4']);
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Line 4');
  const submit = v.$('button[type="submit"]') as HTMLButtonElement;
  assert.equal(submit.disabled, true);
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added, []);
  await typeComment(v, '  use a constant  ');
  await keyIn(v.$('textarea')!, 'Enter', { shiftKey: true });
  assert.deepEqual(added, []);
  await keyIn(v.$('textarea')!, 'Enter', { isComposing: true });
  assert.deepEqual(added, []);
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added, [
    [{ path: 's.txt', workspace: '/repo', startSide: 'R', startLine: 4, endSide: 'R', endLine: 4, hunk: '+new' }, 'use a constant'],
  ]);
  assert.equal(v.$('textarea'), null);
  assert.deepEqual(picked(v), []);
  await v.unmount();
});

test('inline: dragging over rows picks a range across sides; Shift extends it; the button and Cancel or Escape close it', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  const rows = v.$$('.idiff-row');
  await mouse(v.$$('.diff-comment-add')[0], 'mousedown');
  await mouse(rows[1], 'mouseover');
  await mouse(rows[2], 'mouseover');
  assert.deepEqual(picked(v), ['3', '4', '4']);
  await mouse(window as any, 'mouseup');
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 3-4');
  // the box sits under the last picked row
  assert.equal(rows[2].nextElementSibling!.className, 'diff-comment-wrap');
  // hovering without a drag leaves the range alone
  await mouse(rows[3], 'mouseover');
  assert.deepEqual(picked(v), ['3', '4', '4']);
  await mouse(v.$$('.diff-comment-add')[3], 'mousedown', { shiftKey: true });
  await mouse(window as any, 'mouseup');
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 3-5');
  await typeComment(v, 'all of it');
  await act(async () => (v.$('button[type="submit"]') as HTMLButtonElement).click());
  assert.deepEqual(added[0][0], {
    path: 's.txt',
    workspace: '/repo',
    startSide: 'R',
    startLine: 3,
    endSide: 'R',
    endLine: 5,
    hunk: ' keep\n-old\n+new\n tail',
  });
  // a range that starts on a deleted line crosses sides
  await mouse(v.$$('.diff-comment-add')[1], 'mousedown');
  await mouse(rows[2], 'mouseover');
  await mouse(window as any, 'mouseup');
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines L4-R4');
  await keyIn(v.$('textarea')!, 'Escape');
  assert.equal(v.$('textarea'), null);
  // a right press does nothing; a keyboard press opens the box for its row alone; Cancel closes it
  await mouse(v.$$('.diff-comment-add')[0], 'mousedown', { button: 2 });
  assert.deepEqual(picked(v), []);
  await act(async () =>
    (v.$$('.diff-comment-add')[0] as HTMLButtonElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }) as any),
  );
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Line 3');
  await mouse(v.$$('.diff-comment-add')[0], 'click', { detail: 1 });
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Line 3');
  await act(async () => [...v.$$('button')].find((b) => b.textContent === 'Cancel')!.click());
  assert.equal(v.$('textarea'), null);
  await v.unmount();
});

test('split: each half comments on its own file, and a drag stays in the column it started in', async () => {
  const v = await render(h(SplitDiff, { file, commenting }));
  const left = v.$$('.split-row').map((r) => r.children[0] as HTMLElement);
  const right = v.$$('.split-row').map((r) => r.children[1] as HTMLElement);
  await mouse(left[0].querySelector('.diff-comment-add')!, 'mousedown');
  await mouse(right[1], 'mouseover');
  await mouse(left[1], 'mouseover');
  await mouse(window as any, 'mouseup');
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 3-4');
  await typeComment(v, 'old side');
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added[0][0], {
    path: 's.txt',
    workspace: '/repo',
    startSide: 'L',
    startLine: 3,
    endSide: 'L',
    endLine: 4,
    hunk: ' keep\n-old',
  });
  await mouse(right[2].querySelector('.diff-comment-add')!, 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'new side');
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added[1][0], {
    path: 's.txt',
    workspace: '/repo',
    startSide: 'R',
    startLine: 5,
    endSide: 'R',
    endLine: 5,
    hunk: ' tail',
  });
  await v.unmount();
});

test('notes on the old side go under their old line in both views', async () => {
  const note = { line: 4, side: 'L' as const, key: 'n', node: h('aside', { 'data-note': 'n' }) };
  const v = await render(h(InlineDiff, { file, bare: true, notes: [note] }));
  assert.equal(v.$('aside')!.previousElementSibling!.querySelector('.idiff-ln')!.textContent, '4');
  assert.ok(v.$('aside')!.previousElementSibling!.classList.contains('del'));
  await v.rerender(h(SplitDiff, { file, notes: [note] }));
  assert.equal(v.$('aside')!.previousElementSibling!.children[0].querySelector('.idiff-ln')!.textContent, '4');
  await v.unmount();
});

test('a range skips rows with no line in its column; labels and the pending comment', async () => {
  assert.deepEqual(commentRange([{ side: 'R', line: 2, sign: '+', text: 'x' }, undefined], 1, 0, 'a'), {
    path: 'a',
    startSide: 'R',
    startLine: 2,
    endSide: 'R',
    endLine: 2,
    hunk: '+x',
  });
  assert.equal(rangeLabel({ startSide: 'R', startLine: 1, endSide: 'R', endLine: 1 }), 'Line 1');
  assert.equal(linesLabel('L1-R2'), 'Lines L1-R2');
  const v = await render(
    h(PendingDiffComment, { range: { path: 'a', startSide: 'R', startLine: 1, endSide: 'R', endLine: 2, hunk: '' }, comment: 'hello' }),
  );
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines 1-2In your next message');
  assert.equal(v.$('.diff-comment-text')!.textContent, 'hello');
  await v.unmount();
});

test('a line without a number on its side has no add button', async () => {
  const broken = { ...file, lines: file.lines.map((l: any) => (l.kind === 'add' ? { ...l, newNo: undefined } : l)) };
  const v = await render(h(InlineDiff, { file: broken, bare: true, commenting }));
  assert.equal(v.$$('.diff-comment-add').length, 3);
  await v.unmount();
});

test('the open box survives a re-read with the same lines, and closes when the lines change', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'draft');
  // the pane reads git again: a new object with the same lines
  await v.rerender(h(InlineDiff, { file: { ...file, lines: file.lines.map((l: any) => ({ ...l })) }, bare: true, commenting }));
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'draft');
  const changed = parseUnifiedDiff('--- a/s.txt\n+++ b/s.txt\n@@ -3,3 +3,3 @@\n keep\n-old\n+newer\n tail')[0];
  await v.rerender(h(InlineDiff, { file: changed, bare: true, commenting }));
  assert.equal(v.$('textarea'), null);
  assert.deepEqual(picked(v), []);
  await v.unmount();
});

test('a drag released outside the window ends when the pointer comes back with no button held', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  const rows = v.$$('.idiff-row');
  await mouse(v.$$('.diff-comment-add')[0], 'mousedown');
  await mouse(rows[1], 'mouseover', { buttons: 1 });
  // released over another app: the next row entered has no button down
  await mouse(rows[2], 'mouseover', { buttons: 0 });
  // the range is what was dragged over (line 3 to the deleted line 4), not the row the pointer came back on
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Lines R3-L4');
  // no longer dragging: hovering further leaves the range alone
  await mouse(rows[3], 'mouseover', { buttons: 1 });
  assert.deepEqual(picked(v), ['3', '4']);
  await v.unmount();
});

test('Comment on GitHub posts the comment on its range; a failed post keeps the box and its text to try again', async () => {
  const posts: [any, string][] = [];
  let answer = false;
  const onPost = async (range: any, comment: string) => (posts.push([range, comment]), answer);
  const v = await render(h(InlineDiff, { file, bare: true, commenting: { ...commenting, onPost } }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  const github = () => [...v.$$('.diff-comment-actions button')].find((b) => /GitHub|Posting/.test(b.textContent ?? ''))!;
  assert.equal((github() as HTMLButtonElement).disabled, true);
  await typeComment(v, '  on github  ');
  await act(async () => github().click());
  assert.deepEqual(
    posts.map(([r, c]) => [r.endLine, c]),
    [[4, 'on github']],
  );
  assert.ok(v.$('textarea'), 'a failed post keeps the box');
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, '  on github  ');
  answer = true;
  await act(async () => github().click());
  assert.equal(v.$('textarea'), null, 'posted: the box closes');
  assert.deepEqual(added, [], 'nothing went to the composer');
  await v.unmount();
});

test('the box offers no GitHub post where the line cannot go there', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  assert.deepEqual(
    v.$$('.diff-comment-actions button').map((b) => b.textContent),
    ['Cancel', 'Add comment'],
  );
  await v.unmount();
});

test('a pending GitHub post owns its text and cannot submit it to the agent with Enter', async () => {
  let finish!: (posted: boolean) => void;
  const onPost = () => new Promise<boolean>((resolve) => (finish = resolve));
  const v = await render(h(InlineDiff, { file, bare: true, commenting: { ...commenting, onPost } }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'keep this comment');
  await act(async () => v.$$('.diff-comment-actions button')[1].click());
  await keyIn(v.$('textarea')!, 'Enter');
  assert.deepEqual(added, [], 'Enter must respect the pending operation, as the button does');
  assert.equal((v.$('textarea') as HTMLTextAreaElement).readOnly, true);
  await act(async () => finish(false));
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'keep this comment');
  assert.equal((v.$('textarea') as HTMLTextAreaElement).readOnly, false);
  await v.unmount();
});

test('a late post completion cannot close a newer comment range', async () => {
  let finish!: (posted: boolean) => void;
  const onPost = () => new Promise<boolean>((resolve) => (finish = resolve));
  const v = await render(h(InlineDiff, { file, bare: true, commenting: { ...commenting, onPost } }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'first');
  await act(async () => v.$$('.diff-comment-actions button')[1].click());
  await keyIn(v.$('textarea')!, 'Escape');
  await mouse(v.$$('.diff-comment-add')[0], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'new draft');
  await act(async () => finish(true));
  assert.equal((v.$('textarea') as HTMLTextAreaElement | null)?.value, 'new draft');
  await v.unmount();
});

test('a rejected posting callback keeps the text and exits Posting so it can be retried', async () => {
  const v = await render(
    h(InlineDiff, {
      file,
      bare: true,
      commenting: {
        ...commenting,
        onPost: async () => {
          throw new Error('offline');
        },
      },
    }),
  );
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'retained');
  await act(async () => v.$$('.diff-comment-actions button')[1].click());
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'retained');
  assert.ok(v.$('[role="alert"]'));
  assert.equal((v.$$('.diff-comment-actions button')[1] as HTMLButtonElement).disabled, false);
  await v.unmount();
});

test('blank and overlapping post clicks dispatch no duplicate writes', async () => {
  let count = 0;
  let finish!: (ok: boolean) => void;
  const onPost = () => {
    count++;
    return new Promise<boolean>((r) => {
      finish = r;
    });
  };
  const v = await render(h(InlineDiff, { file, bare: true, commenting: { ...commenting, onPost } }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  const post = () => v.$$('.diff-comment-actions button')[1] as HTMLButtonElement;
  assert.equal(post().disabled, true);
  await act(async () => post().click());
  assert.equal(count, 0);
  await typeComment(v, 'One write');
  await act(async () => {
    post().click();
    post().click();
  });
  assert.equal(count, 1);
  assert.equal(post().disabled, true);
  await act(async () => finish(true));
  await v.unmount();
});

test('a refused composer attachment retains the typed diff comment and its range', async () => {
  const v = await render(h(InlineDiff, { file, bare: true, commenting: { ...commenting, onAdd: () => false } }));
  await mouse(v.$$('.diff-comment-add')[2], 'mousedown');
  await mouse(window as any, 'mouseup');
  await typeComment(v, 'keep this comment');
  await keyIn(v.$('textarea')!, 'Enter');
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'keep this comment');
  assert.equal(v.$('.diff-comment-head')!.textContent, 'Line 4');
});

// Selection annotations retain their passage, comment, and composer ownership through the shared toolbar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as react from 'react';
import type { Attachment } from '../src/store/types.ts';
import { annotationAttachment, editSelection, removeSelection } from '../src/lib/annotations.ts';
import { iconStubs, mockSource, withStoreSlices } from './support/stubs.ts';
import { fixture, annotationStoreStubs } from './support/selection-annotation-store.ts';
Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: (window as any).DOMRect });
Object.defineProperty(window, 'innerWidth', { value: 960, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => {
  frames.set(++nextFrame, fn);
  return nextFrame;
};
(globalThis as any).cancelAnimationFrame = (id: number) => frames.delete(id);
const observers = new Set<() => void>();
class Observer {
  callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    observers.add(callback);
  }
  observe() {}
  disconnect() {
    observers.delete(this.callback);
  }
}
(globalThis as any).ResizeObserver = Observer;
(globalThis as any).MutationObserver = Observer;
(window.Range.prototype as any).getClientRects = function () {
  return (
    fixture.rects ??
    (this.toString() ? [new window.DOMRect(200 + this.startOffset * 4, 240, Math.max(6, this.toString().length * 6), 20)] : [])
  );
};
const f = fixture;
const stubs: Record<string, Record<string, unknown>> = {
  store: annotationStoreStubs,
  'components/ui/icons.tsx': iconStubs(),
  'components/ui/Dictation.tsx': {
    Dictation: ({ onText }: any) =>
      react.createElement('button', { type: 'button', 'aria-label': 'Dictate', onClick: () => onText(f.dictated) }, 'Mic'),
  },
  'components/ui/Popover.tsx': { Popover: (p: any) => p.open && react.createElement('div', { className: p.className }, p.children) },
};
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);
const { act, createElement, useEffect, useRef, useState } = react;
const { createRoot } = await import('react-dom/client');
const { SelectionToolbar } = await import('../src/components/thread/SelectionToolbar.tsx');
const { SelectionChip } = await import('../src/components/composer/SelectionChip.tsx');
const { AnnotationComment } = await import('../src/components/composer/AnnotationComment.tsx');
const { useSelectionAttachments } = await import('../src/components/composer/useSelectionAttachments.ts');
const { useComposerDraft } = await import('../src/components/composer/useComposerDraft.ts');
async function flush() {
  for (let step = 0; step < 12; step++) {
    if (!frames.size) break;
    await act(() => {
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach((fn) => fn(step));
    });
  }
  assert.equal(frames.size, 0, 'animation frames must settle');
}
async function fire(target: EventTarget, event: Event) {
  await act(() => target.dispatchEvent(event));
  await flush();
}
async function input(value: string) {
  const el = document.querySelector<HTMLInputElement>('.annotation-comment-input input')!;
  assert.ok(el);
  await act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  await flush();
  return el;
}
async function key(value: string, extra = {}) {
  const el = document.querySelector('.annotation-comment-input input')!;
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
  await fire(el, event as any);
  // Native form submission is the browser boundary in this DOM unit fixture.
  if (value === 'Enter' && !event.defaultPrevented)
    await fire(el.closest('form')!, new window.Event('submit', { bubbles: true, cancelable: true }) as any);
  return event;
}
function button(label: string) {
  const el = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label);
  assert.ok(el, label);
  return el;
}
async function click(label: string, pointer = true) {
  const el = button(label);
  if (pointer) {
    await act(() => {
      el.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as any);
      el.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }) as any);
      el.click();
    });
  } else await act(() => el.click());
  await flush();
}

async function mount(t: any, initial: Attachment[] = [], withToolbar = true, inPane = false) {
  fixture.state = { drafts: {} };
  fixture.rects = null;
  fixture.sideChats = [];
  window.getSelection()?.removeAllRanges();
  frames.clear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  let current: Attachment[] = [];
  function App({ threadId = 'main' }) {
    const scroll = useRef<any>(null),
      field = useRef<any>(null);
    const [items, setItems] = useState(initial);
    current = items;
    useSelectionAttachments(threadId, setItems, field);
    useEffect(() => {
      fixture.state = { drafts: { [threadId]: { attachments: items } } };
      fixture.changed();
    }, [items, threadId]);
    return createElement(
      'div',
      {},
      createElement(
        'div',
        { ref: scroll, className: 'thread-scroll' },
        createElement(
          'div',
          { className: 'assistant-message' },
          createElement(
            'div',
            { 'data-selection-source': 'reply' },
            createElement('div', { className: 'md' }, 'first point then second point'),
          ),
        ),
      ),
      createElement('textarea', { ref: field }),
      createElement(SelectionChip, {
        selections: items.filter((a) => a.kind === 'selection'),
        onRemove: () => setItems((all) => all.filter((a) => a.kind !== 'selection')),
        onEdit: (index: number, text: string) => setItems((all) => editSelection(all, index, text)),
        onRemoveSelection: (index: number) => setItems((all) => removeSelection(all, index)),
      }),
      withToolbar && createElement(SelectionToolbar, { key: threadId, containerRef: scroll, threadId, inPane }),
    );
  }
  // Geometry is a browser boundary; all selections and range offsets are real DOM ranges.
  const bounds = new window.DOMRect(100, 100, 760, 480);
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('selection-toolbar') ? new window.DOMRect(0, 0, 340, 48) : bounds;
  };
  const render = (threadId = 'main') => act(() => root.render(createElement(App, { threadId })));
  await render();
  await flush();
  const close = async () => {
    await act(() => root.unmount());
    host.remove();
    window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    frames.clear();
  };
  t.after(close);
  return {
    host,
    render,
    get items() {
      return current;
    },
    async select(start = 0, end = 11) {
      const source = host.querySelector('[data-selection-source] > .md')!;
      const range = document.createRange();
      range.setStart(source.firstChild!, start);
      range.setEnd(source.firstChild!, end);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range as any);
      await fire(document, new window.Event('selectionchange') as any);
    },
  };
}

test('Reply creates a numbered annotation and edits its optional comment without changing the main prompt', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  assert.equal(m.items[0].text, 'first point');
  assert.equal(document.querySelector('.annotation-marker')?.textContent, '1');
  assert.equal(document.querySelector('input')?.placeholder, 'Add an optional comment…');
  assert.equal(document.querySelector('textarea')?.value, '');
  await input('11');
  await key('Enter');
  assert.equal(m.items[0].annotation, '11');
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
  assert.ok(document.querySelector('.annotation-marker'));
  assert.equal(document.querySelector('.selection-chip-label')?.textContent, '1 annotation');
});

test('two selections preserve their own comments and source markers', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await input('11');
  await key('Enter');
  await m.select(17, 29);
  await click('Reply');
  await input('222');
  await key('Enter');
  assert.deepEqual(
    m.items.map((a) => [a.text, a.annotation]),
    [
      ['first point', '11'],
      ['second point', '222'],
    ],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll('.annotation-marker')).map((el) => el.textContent),
    ['1', '2'],
  );
  await click('View 2 annotations');
  assert.deepEqual(
    Array.from(document.querySelectorAll('.selection-pop-text')).map((el) => el.textContent),
    ['first point', '11', 'second point', '222'],
  );
});

test('blank comments, Escape and outside clicks keep the annotation available to the composer', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await key('Escape');
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].annotation, '');
  await click('Edit annotation 1');
  await input('kept');
  await fire(m.host.querySelector('textarea')!, new window.PointerEvent('pointerdown', { bubbles: true }) as any);
  assert.equal(m.items[0].annotation, 'kept');
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
});

test('Chinese input confirmation does not close the comment editor or submit a message', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await input('中文');
  assert.equal((await key('Enter', { isComposing: true })).defaultPrevented, true);
  assert.ok(document.querySelector('.annotation-comment-toolbar'));
  assert.equal((await key('Enter', { keyCode: 229 })).defaultPrevented, true);
  assert.equal(m.items[0].annotation, '中文');
  await key('Enter');
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
});

test('dictation appends to the current comment and clicking the microphone keeps its editor open', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await click('Dictate');
  assert.equal(m.items[0].annotation, 'dictated comment');
  await input('typed');
  await click('Dictate');
  assert.equal(m.items[0].annotation, 'typed dictated comment');
  assert.ok(document.querySelector('.annotation-comment-toolbar'));
});

test('editing and deleting a single annotation updates the list and renumbers the remaining source markers', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await input('old');
  await key('Enter');
  await m.select(17, 29);
  await click('Reply');
  await key('Enter');
  await click('View 2 annotations');
  await click('Edit annotation 1');
  await input('new');
  await key('Enter');
  assert.equal(m.items[0].annotation, 'new');
  await click('Delete annotation 1');
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].text, 'second point');
  assert.equal(document.querySelector('.annotation-marker')?.textContent, '1');
  await click('Remove all annotations');
  assert.equal(m.items.length, 0);
  assert.equal(document.querySelector('.annotation-marker') === null, true);
});

test('keyboard removal while a source editor is open cannot revive a deleted annotation', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  await click('Remove all annotations', false);
  assert.equal(m.items.length, 0);
  assert.equal(document.querySelector('.annotation-marker') === null, true);
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
});

test('source markers and comment highlights follow scroll geometry and hide outside the conversation viewport', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Reply');
  fixture.rects = [new window.DOMRect(250, 350, 60, 20) as any];
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal((document.querySelector('.annotation-marker') as HTMLElement).style.top, '323px');
  assert.equal((document.querySelector('.annotation-selection-highlight') as HTMLElement).style.top, '350px');
  fixture.rects = [new window.DOMRect(250, 800, 60, 20) as any];
  await fire(window as any, new window.Event('scroll') as any);
  assert.equal(document.querySelector('.annotation-marker') === null, true);
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
  fixture.rects = [new window.DOMRect(250, 350, 60, 20) as any];
  await act(() => {
    for (const callback of observers) callback();
  });
  await flush();
  assert.ok(document.querySelector('.annotation-comment-toolbar'));
  assert.equal(m.items.length, 1);
});

test('Start a side chat forwards the selection without creating an annotation in the main composer', async (t) => {
  const m = await mount(t);
  await m.select();
  await click('Start a side chat');
  assert.deepEqual(fixture.sideChats, [['main', 'first point']]);
  assert.deepEqual(m.items, [] as any[]);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
});

test('system notices stay selectable without quotation actions and crossing into them hides the toolbar', async (t) => {
  const m = await mount(t);
  await m.select();
  assert.ok(document.querySelector('.selection-toolbar'));
  const notice = document.createElement('div');
  notice.className = 'divider-label';
  notice.textContent = 'Context automatically compacted';
  m.host.querySelector('.thread-scroll')!.append(notice);
  const range = document.createRange();
  range.selectNodeContents(notice.firstChild!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range as any);
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal(selection.toString(), notice.textContent);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  assert.deepEqual(m.items, [] as any[]);
  assert.deepEqual(fixture.sideChats, []);
  range.setStart(m.host.querySelector('[data-selection-source] > .md')!.firstChild!, 0);
  selection.removeAllRanges();
  selection.addRange(range as any);
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  await m.select();
  await click('Start a side chat');
  assert.deepEqual(fixture.sideChats, [['main', 'first point']]);
});

test('selection events are scoped to the correct thread and retain legacy event compatibility', async (t) => {
  const m = await mount(t, [], false);
  const event = async (name: string, detail: unknown) =>
    fire(window as any, new window.CustomEvent(name, { detail: detail as any }) as any);
  const wrong = { threadId: 'side', text: 'wrong thread', handled: false };
  await event('composer-add-selection', wrong);
  assert.equal(wrong.handled, false);
  assert.deepEqual(m.items, [] as any[]);
  const matching = { threadId: 'main', text: 'plain', handled: false };
  await event('composer-add-selection', matching);
  assert.equal(matching.handled, true, 'mounted composer must suppress the stored-draft fallback');
  assert.equal(m.items[0].text, 'plain');
  assert.equal(m.items[0].annotationId, undefined);
  assert.equal(document.activeElement === m.host.querySelector('textarea'), true);
  await event('composer-add-selection', { threadId: 'main', text: 'old toolbar', comment: 'comment' });
  assert.equal(m.items[1].annotation, 'comment');
  const id = m.items[1].annotationId;
  await event('composer-update-selection', { threadId: 'side', annotationId: id, annotation: 'wrong' });
  assert.equal(m.items[1].annotation, 'comment');
  await event('composer-update-selection', { threadId: 'main', annotationId: id, annotation: 'new' });
  assert.equal(m.items[1].annotation, 'new');
  await m.render('side');
  await flush();
  await event('composer-add-selection', { threadId: 'main', text: 'old thread' });
  assert.equal(m.items.length, 2);
  await event('composer-add-selection', { threadId: 'side', attachment: annotationAttachment('side quote'), focus: false });
  assert.equal(m.items.length, 3);
});

test('the annotation list supports canceling an edit and clicking its pill to close the pinned popover', async (t) => {
  const m = await mount(t, [annotationAttachment('quote', undefined, 'original')], false);
  await click('View 1 annotation');
  await click('Edit annotation 1');
  await input('discard');
  await key('Escape');
  assert.equal(m.items[0].annotation, 'original');
  await click('View 1 annotation');
  assert.equal(document.querySelector('.selection-pop') === null, true);
});

test('a standalone comment trims saved text, handles non-Enter keys and optional onChange callbacks', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const saved: string[] = [];
  let canceled = 0;
  await act(() =>
    root.render(createElement(AnnotationComment, { onSave: (text: string) => saved.push(text), onCancel: () => canceled++ })),
  );
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  await input('  saved  ');
  await key('ArrowLeft');
  await key('Enter');
  assert.deepEqual(saved, ['saved']);
  await click('Dictate');
  assert.equal(document.querySelector('input')?.value, '  saved   dictated comment');
  await key('Escape');
  assert.equal(canceled, 1);
});

test('hover previews close after leaving, remain while pinned, and support read-only legacy snippets', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const edits: unknown[][] = [];
  const render = (extra = {}) =>
    act(() => root.render(createElement(SelectionChip, { selections: ['legacy one', 'legacy two'], align: 'end', ...extra })));
  await render();
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  const enter = async () => fire(host.querySelector('.selection-chip-wrap')!, new window.MouseEvent('mouseover', { bubbles: true }) as any);
  const leave = async () =>
    fire(
      host.querySelector('.selection-chip-wrap')!,
      new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body as any }) as any,
    );
  await enter();
  assert.equal(host.querySelectorAll('.selection-pop-item').length, 2);
  assert.equal(host.querySelectorAll('.selection-pop-actions').length, 0);
  assert.equal(host.querySelector('.selection-pop-text')?.textContent, 'legacy one');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await leave();
  await act(() => t.mock.timers.tick(161));
  assert.equal(host.querySelector('.selection-pop') === null, true);
  await enter();
  await click('View 2 selections');
  await leave();
  await act(() => t.mock.timers.tick(161));
  assert.ok(host.querySelector('.selection-pop'));
  await render({ onEdit: (...args: unknown[]) => edits.push(args) });
  await click('Edit annotation 1');
  await input('legacy comment');
  await key('Enter');
  assert.deepEqual(edits, [[0, 'legacy comment']]);
  await render({ selections: [{ text: 'comment without id', annotation: '' }], onRemoveSelection: () => {} });
  assert.equal(host.querySelector('.selection-pop-actions button')?.getAttribute('aria-label'), 'Delete annotation 1');
  await click('Delete annotation 1');
});

test('outside selections, empty selections and scrolled-out selections never open Reply', async (t) => {
  const m = await mount(t);
  const other = document.createElement('div');
  other.textContent = 'outside';
  document.body.append(other);
  t.after(() => other.remove());
  const range = document.createRange();
  range.selectNodeContents(other);
  window.getSelection()!.addRange(range as any);
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  m.host.querySelector('[data-selection-source] > .md')!.textContent = '   ';
  await m.select(0, 3);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  m.host.querySelector('[data-selection-source] > .md')!.textContent = 'first point then second point';
  fixture.rects = [];
  await m.select();
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  fixture.rects = [new window.DOMRect(1000, 200, 50, 20) as any];
  await m.select();
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  fixture.rects = [new window.DOMRect(200, 900, 50, 20) as any];
  await m.select();
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
});

test('pointer selection hides the toolbar until release; Escape clears it and mouse-down preserves the range', async (t) => {
  const m = await mount(t);
  await m.select();
  const mouse = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await fire(button('Reply'), mouse as any);
  assert.equal(mouse.defaultPrevented, true);
  await fire(window as any, new window.KeyboardEvent('keydown', { key: 'ArrowLeft' }) as any);
  assert.ok(document.querySelector('.selection-toolbar'));
  await fire(window as any, new window.KeyboardEvent('keydown', { key: 'Escape' }) as any);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  await m.select();
  await fire(m.host.querySelector('[data-selection-source]')!, new window.PointerEvent('pointerdown', { bubbles: true }) as any);
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
  await fire(window as any, new window.PointerEvent('pointercancel') as any);
  assert.ok(document.querySelector('.selection-toolbar'));
});

test('old or removed draft sources do not render misleading markers', async (t) => {
  const source = { messageId: 'reply', start: 0, end: 11 };
  const m = await mount(t, [
    { kind: 'file', path: '/a.ts', name: 'a.ts' },
    { kind: 'selection', path: '', name: '', text: 'plain' },
    annotationAttachment('first point', source),
    annotationAttachment('gone', { messageId: 'gone', start: 0, end: 4 }),
  ]);
  assert.equal(document.querySelectorAll('.annotation-marker').length, 1);
  const marker = document.querySelector('.annotation-marker')!;
  const mouse = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await fire(marker, mouse as any);
  assert.equal(mouse.defaultPrevented, true);
  // Remove the quote between the marker's display and its click.
  m.host.querySelector('[data-selection-source] > .md')!.textContent = 'changed text';
  await act(() => (marker as HTMLElement).click());
  await flush();
  assert.equal(document.querySelector('.annotation-marker') === null, true);
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
});

test('a toolbar without a mounted scroll container ignores selection and geometry events', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  fixture.state = { drafts: {} };
  await act(() => root.render(createElement(SelectionToolbar, { containerRef: { current: null }, threadId: 'unmounted' })));
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  await fire(window as any, new window.Event('resize') as any);
  assert.equal(document.querySelector('.selection-toolbar') === null, true);
});

test('an unsaved annotation remains editable before the composer acknowledges its attachment', async (t) => {
  fixture.state = { drafts: {} };
  fixture.rects = null;
  frames.clear();
  window.getSelection()!.removeAllRanges();
  fixture.rects = [new window.DOMRect(200, 20, 60, 20) as any];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const container = document.createElement('div');
  container.innerHTML = '<div class="assistant-message"><div data-selection-source="reply"><div class="md">first point</div></div></div>';
  host.append(container);
  container.getBoundingClientRect = () => new window.DOMRect(0, 0, 960, 600) as any;
  let added: Attachment | undefined;
  const listen = (e: Event) => {
    added = (e as CustomEvent).detail.attachment;
  };
  window.addEventListener('composer-add-selection', listen as any);
  const containerRef = { current: container as HTMLElement | null };
  await act(() => root.render(createElement(SelectionToolbar, { containerRef, threadId: 'unsaved' })));
  // The source container is owned by the surrounding thread, not the toolbar's render root.
  host.append(container);
  t.after(async () => {
    window.removeEventListener('composer-add-selection', listen as any);
    await act(() => root.unmount());
    host.remove();
    frames.clear();
  });
  const range = document.createRange();
  range.selectNodeContents(container.querySelector('.md')!);
  window.getSelection()!.addRange(range as any);
  await fire(document, new window.Event('selectionchange') as any);
  assert.equal((document.querySelector('.selection-toolbar') as HTMLElement).style.top, '12px');
  await click('Reply');
  assert.ok(added);
  assert.ok(document.querySelector('.annotation-marker'));
  await click('Edit annotation 1');
  assert.ok(document.querySelector('.annotation-comment-toolbar'));
  await key('Enter');
  // Persist the attachment and reopen its editor from the marker.
  fixture.state = { drafts: { unsaved: { attachments: [added!] } } };
  await act(() => fixture.changed());
  await flush();
  const deletedMarker = document.querySelector('.annotation-marker') as HTMLElement;
  fixture.state = { drafts: {} };
  await act(() => fixture.changed());
  await act(() => deletedMarker.click());
  await flush();
  assert.equal(document.querySelector('.annotation-comment-toolbar') === null, true);
  fixture.state = { drafts: { unsaved: { attachments: [added!] } } };
  await act(() => fixture.changed());
  await flush();
  const staleMarker = document.querySelector('.annotation-marker') as HTMLElement;
  containerRef.current = null;
  await act(() => root.render(createElement(SelectionToolbar, { containerRef, threadId: 'unsaved' })));
  await act(() => staleMarker.click());
  await flush();
  assert.ok(document.querySelector('.annotation-comment-toolbar'));
});

test('draft persistence debounces typing, immediately saves attachment edits and flushes only the correct thread on exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const calls: { key: string; text: string; attachments: Attachment[] }[] = [];
  const save = (key: string, draft: { text: string; attachments: Attachment[] }) => {
    calls.push({ key, ...draft });
  };
  const none: Attachment[] = [];
  function Probe({ draftKey, text, attachments }: any) {
    useComposerDraft(draftKey, text, attachments, save);
    return null;
  }
  const render = (draftKey: string, text: string, attachments = none) =>
    act(() => root.render(createElement(Probe, { draftKey, text, attachments })));
  await render('main', 'first');
  assert.deepEqual(calls, [] as any[]);
  await act(() => t.mock.timers.tick(199));
  assert.deepEqual(calls, [] as any[]);
  await render('main', 'latest');
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls, [{ key: 'main', text: 'latest', attachments: none }]);
  const annotated = [annotationAttachment('quote')];
  await render('main', 'latest', annotated);
  assert.equal(calls.at(-1)!.attachments, annotated);
  await render('main', 'unsaved typing', annotated);
  await render('side', 'side draft');
  assert.equal(calls.at(-1)!.key, 'main');
  assert.equal(calls.at(-1)!.text, 'unsaved typing');
  await act(() => t.mock.timers.tick(200));
  assert.equal(calls.at(-1)!.key, 'side');
  await act(() => root.unmount());
  assert.equal(calls.length, 4, 'already saved drafts must not be saved again at unmount');
  host.remove();
});

test('an unsaved text draft is flushed when an approval card replaces the composer', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const calls: unknown[][] = [];
  const save = (...args: unknown[]) => {
    calls.push(args);
  };
  const attachments: Attachment[] = [];
  function Probe() {
    useComposerDraft('main', 'pending text', attachments, save);
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  await act(() => root.unmount());
  host.remove();
  assert.deepEqual(calls, [['main', { text: 'pending text', attachments }]]);
});

test('draft persistence keeps an explicit Goal flag alongside annotations', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const calls: unknown[][] = [];
  const save = (...args: unknown[]) => {
    calls.push(args);
  };
  const attachments = [annotationAttachment('quote')];
  function Probe() {
    useComposerDraft('main', 'goal text', attachments, save, false);
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  await act(() => root.unmount());
  host.remove();
  assert.deepEqual(calls, [['main', { text: 'goal text', attachments, goal: false }]]);
});

test('side-chat selections offer only Reply and attach annotations to that side chat', async (t) => {
  const m = await mount(t, [], true, true);
  await m.render('side');
  await flush();
  await m.select();
  assert.deepEqual(
    Array.from(document.querySelectorAll('.selection-toolbar-bar button')).map((b) => b.textContent),
    ['Reply'],
  );
  assert.equal(document.querySelector('.selection-toolbar-divider') === null, true);
  await click('Reply');
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].text, 'first point');
  assert.deepEqual(fixture.state.drafts.side.attachments, m.items);
  assert.equal(fixture.state.drafts.main, undefined);
  assert.deepEqual(fixture.sideChats, []);
  assert.ok(document.querySelector('.annotation-comment-toolbar'), 'side-chat annotations remain editable');
});

// Selection action and comment popovers follow their measured size, viewport and owning pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { window } from './support/dom.ts';
import { SelectionPopover, selectionPopoverPosition } from '../src/components/thread/SelectionPopover.tsx';

const rect = (left: number, top: number, width: number, height: number) => new window.DOMRect(left, top, width, height) as DOMRect;
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 682 });

test('the popup stays below a line near the pane top, with horizontal room limited to that pane', () => {
  assert.deepEqual(selectionPopoverPosition(rect(760, 110, 200, 24), rect(730, 100, 294, 500), 48), {
    left: 860,
    top: 142,
    maxWidth: 278,
    maxHeight: 484,
    transform: 'translateX(clamp(-122px, -50%, calc(156px - 100%)))',
  });
});

test('the popup fits above a low selection and respects the window when the pane extends outside it', () => {
  const style = selectionPopoverPosition(rect(0, 650, 100, 24), rect(-30, -20, 1200, 900), 48);
  assert.equal(style.top, 642);
  assert.equal(style.maxWidth, 1008);
  assert.equal(style.maxHeight, 666);
  assert.equal(style.transform, 'translateX(clamp(-42px, -50%, calc(966px - 100%))) translateY(-100%)');
});

test('a tall wrapped popup moves up inside the pane; an oversized one scrolls within it', () => {
  const bounds = rect(300, 100, 300, 140);
  assert.equal(selectionPopoverPosition(rect(400, 120, 80, 24), bounds, 100).top, 132);
  const style = selectionPopoverPosition(rect(400, 120, 80, 24), bounds, 200);
  assert.equal(style.top, 108);
  assert.equal(style.maxHeight, 124);
  assert.equal(selectionPopoverPosition(rect(400, 900, 80, 24), bounds, 40).top, 232);
  const hidden = selectionPopoverPosition(rect(400, 120, 80, 24), rect(400, 100, 0, 0), 40);
  assert.equal(hidden.maxWidth, 0);
  assert.equal(hidden.maxHeight, 0);
});

test('measuring, pane moves and popup/font resize reposition the surface; cleanup and remount retire its observers', async (t) => {
  const observers = new Set<{ callback: () => void; elements: Element[] }>();
  const originalObserver = globalThis.ResizeObserver;
  class Observer {
    record: { callback: () => void; elements: Element[] };
    constructor(callback: () => void) {
      this.record = { callback, elements: [] };
      observers.add(this.record);
    }
    observe(element: Element) {
      this.record.elements.push(element);
    }
    disconnect() {
      observers.delete(this.record);
    }
  }
  globalThis.ResizeObserver = Observer as any;
  const host = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(host, container);
  const root = createRoot(host);
  const surfaceRef = createRef<HTMLDivElement>();
  const containerRef = { current: container as HTMLElement | null };
  let bounds = rect(300, 100, 300, 400);
  container.getBoundingClientRect = () => bounds;
  const selected = rect(400, 170, 100, 24);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    container.remove();
    globalThis.ResizeObserver = originalObserver;
  });
  const render = () =>
    act(() =>
      root.render(
        h(
          StrictMode,
          {},
          h(SelectionPopover, {
            rect: selected,
            containerRef,
            surfaceRef,
            children: h('button', {}, 'Reply'),
          }),
        ),
      ),
    );
  await render();
  assert.equal(observers.size, 1, 'Strict Mode keeps only the current effect');
  assert.deepEqual([...observers][0].elements, [surfaceRef.current, container]);
  let height = 40;
  surfaceRef.current!.getBoundingClientRect = () => rect(0, 0, 280, height);
  const resize = () =>
    act(() => {
      for (const o of observers) o.callback();
    });
  await resize();
  assert.equal(surfaceRef.current!.style.top, '162px');
  height = 80;
  await resize();
  assert.equal(surfaceRef.current!.style.top, '202px', 'larger text moves the popup below the selected line');
  const same = surfaceRef.current!.getAttribute('style');
  await resize();
  assert.equal(surfaceRef.current!.getAttribute('style'), same);
  bounds = rect(300, 200, 240, 300);
  await act(() => window.dispatchEvent(new window.Event('scroll') as any));
  assert.equal(surfaceRef.current!.style.top, '208px');
  bounds = rect(300, 250, 200, 250);
  await act(() => window.dispatchEvent(new window.Event('resize') as any));
  assert.equal(surfaceRef.current!.style.maxWidth, '184px');
  await act(() => root.render(null));
  assert.equal(observers.size, 0);
  await render();
  assert.equal(observers.size, 1);
});

test('a missing transcript leaves the popup hidden without installing observers', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const surfaceRef = createRef<HTMLDivElement>();
  await act(() =>
    root.render(
      h(SelectionPopover, {
        rect: rect(0, 0, 10, 10),
        containerRef: { current: null },
        surfaceRef,
        className: 'annotation-comment-toolbar',
        children: 'comment',
      }),
    ),
  );
  assert.equal(surfaceRef.current!.style.opacity, '0');
  assert.ok(surfaceRef.current!.classList.contains('annotation-comment-toolbar'));
  await act(() => root.unmount());
});

test('an annotation input can autofocus during mount before its popup is measured', async (t) => {
  const host = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(host, container);
  const root = createRoot(host);
  container.getBoundingClientRect = () => rect(100, 100, 400, 400);
  const originalFocus = window.HTMLInputElement.prototype.focus;
  // Chromium refuses focus inside visibility:hidden; happy-dom otherwise masks the autofocus ordering.
  window.HTMLInputElement.prototype.focus = function () {
    for (let el: HTMLElement | null = this as any; el; el = el.parentElement) {
      if (el.style.visibility === 'hidden') return;
    }
    originalFocus.call(this);
  };
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    container.remove();
    window.HTMLInputElement.prototype.focus = originalFocus;
  });
  await act(() =>
    root.render(
      h(SelectionPopover, {
        rect: rect(200, 200, 100, 24),
        containerRef: { current: container },
        surfaceRef: createRef<HTMLDivElement>(),
        children: h('input', { autoFocus: true, 'aria-label': 'Annotation comment' }),
      }),
    ),
  );
  assert.equal(document.activeElement, host.querySelector('input'));
});

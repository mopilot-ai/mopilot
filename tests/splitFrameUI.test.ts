// Split view's main area (src/components/split/SplitFrame.tsx, SplitPaneHead.tsx): the primary page alone until a split
// pane opens (same structure, so the primary chat never remounts), each pane's chat beside it with its header, the
// focused pane marked, a click focusing a pane, separators resized by drag or keys, and the pane menu.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore, iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { NO_SPLIT, applySplit, primaryChat, type SplitLayout, type SplitOp } from '../src/store/split.ts';
import { splitRoom } from '../src/session/splitWeights.ts';
import { installNativeStub } from './support/ports/native.ts';

// a mocked .tsx module keeps loading through tests/support/register.ts (see shell-sidebar-kit.ts)
registerHooks({
  load(url, context, next) {
    const u = new URL(url);
    if (u.protocol === 'file:' && u.pathname.endsWith('.tsx') && u.searchParams.has('node-test-mock'))
      return next(url.split('?')[0], context);
    return next(url, context);
  },
});

const ops: SplitOp[] = [];
const calls: unknown[][] = [];
const store = fakeStore<{ route: any; split: SplitLayout; threads: Record<string, any> }>(
  { route: { name: 'thread', id: 'p' }, split: NO_SPLIT, threads: {} },
  (run) => act(run),
);
let popup: string | null = null;
let popupItems: any[] = [];

stubStore({
  useStore: store.useStore,
  applySplitOp: (op: SplitOp) => {
    ops.push(op);
    const s = store.getState();
    const { layout, result } = applySplit(s.split, primaryChat(s), op);
    store.setState({ split: layout });
    return result;
  },
  setSplitRoom: (n: number) => calls.push(['room', n]),
  moveSplitPane: (chatId: string, by: number) => calls.push(['move', chatId, by]),
  navigate: (route: unknown) => calls.push(['navigate', route]),
  openInSplit: (chatId: string, at?: number) => calls.push(['openInSplit', chatId, at]),
  threadTitle: (t: any) => t?.name ?? 'New chat',
});
mockSource('src/components/thread/ThreadView.tsx', {
  ThreadView: ({ threadId }: { threadId: string }) => h('div', { 'data-view': threadId }),
});
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/components/ui/icons.tsx', iconStubs());
installNativeStub({
  menu: {
    popup: async (items: any[]) => {
      popupItems = items;
      if (popup === 'fail') throw new Error('no menu');
      return popup;
    },
  },
});
const { SplitFrame } = await import('../src/components/split/SplitFrame.tsx');

/** The frame's measured width: happy-dom lays nothing out, so the test says how wide the main area is. */
let width = 1800;
const rect = window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains('split-frame')) return { width, height: 600, top: 0, left: 0, right: width, bottom: 600 } as DOMRect;
  // a pane: an equal share of the frame by its place among the panes
  if (this.dataset.splitTarget !== undefined) {
    const all = [...(this.parentElement?.querySelectorAll(':scope > [data-split-target]') ?? [])];
    const w = width / all.length;
    const left = all.indexOf(this) * w;
    return { width: w, height: 600, top: 0, left, right: left + w, bottom: 600 } as DOMRect;
  }
  return rect.call(this);
};
(window.HTMLElement.prototype as any).setPointerCapture ??= () => {};
(window.HTMLElement.prototype as any).releasePointerCapture ??= () => {};

async function mount(props: { splits?: boolean; primaryInert?: boolean } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const page = h('div', { className: 'page' }, 'primary page');
  await act(async () => root.render(h(SplitFrame, { ...props, children: page })));
  return {
    host,
    $: (sel: string) => host.querySelector(sel) as HTMLElement,
    $$: (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[],
    rerender: (next: typeof props) => act(async () => root.render(h(SplitFrame, { ...next, children: page }))),
    unmount: () => act(async () => root.unmount()),
  };
}
const fire = (el: Element, ev: Event) => act(async () => void el.dispatchEvent(ev));
const pointer = (el: Element, type: string, init: Record<string, any> = {}) =>
  fire(el, new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init }) as any);
/** One animation frame: a drag paints once per frame (src/lib/edgeDrag.ts). */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));
const layout = (panes: string[], focus = 'primary', weights: number[] = []) =>
  store.setState({
    split: { panes: panes.map((chatId, i) => ({ chatId, weight: weights[i + 1] ?? 1 })), focus, primaryWeight: weights[0] ?? 1 },
  });

beforeEach(() => {
  ops.length = 0;
  calls.length = 0;
  popup = null;
  width = 1800;
  store.setState({ route: { name: 'thread', id: 'p' }, split: NO_SPLIT, threads: { a: { name: 'Alpha' }, b: { name: 'Beta' } } });
});

test('without split panes the page is alone in the frame, unmarked, and the room is measured', async () => {
  const v = await mount({ primaryInert: true });
  assert.equal(v.$$('.split-pane').length, 1);
  assert.equal(v.$('.split-frame').className, 'split-frame');
  assert.equal(v.$('.split-pane').hasAttribute('data-focused'), false);
  assert.equal(v.$('.split-pane').hasAttribute('inert'), true, 'the chat being left takes nothing');
  assert.equal(v.$$('.split-sep').length, 0);
  assert.deepEqual(calls, [['room', splitRoom(1800)]]);
  // a click focuses nothing: the window's only pane
  await pointer(v.$('.page'), 'pointerdown');
  assert.equal(ops.length, 0);
  await v.unmount();
});

test('split panes sit beside the page with their header and chat; the page is not remounted', async () => {
  const v = await mount();
  const page = v.$('.page');
  layout(['a', 'b'], 'a');
  await act(async () => {});
  assert.equal(v.$('.page'), page, 'the same primary page element');
  assert.equal(v.$('.split-frame').className, 'split-frame split');
  assert.deepEqual(
    v.$$('.split-pane').map((p) => [p.getAttribute('aria-label'), p.getAttribute('data-focused')]),
    [
      ['Primary pane', 'false'],
      ['Secondary pane', 'true'],
      ['Secondary pane', 'false'],
    ],
  );
  assert.deepEqual(
    v.$$('.split-pane-title').map((t) => t.textContent),
    ['Alpha', 'Beta'],
  );
  assert.deepEqual(
    v.$$('[data-view]').map((t) => t.dataset.view),
    ['a', 'b'],
  );
  assert.equal(v.$$('.split-sep').length, 2);
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1fr) 1px minmax(0, 1fr) 1px minmax(0, 1fr)');
  // a pointer in another pane focuses it; in the focused one, nothing
  await pointer(v.$('.page'), 'pointerdown');
  assert.deepEqual(ops, [{ op: 'focus', target: 'primary' }]);
  await pointer(v.$('.page'), 'pointerdown');
  await fire(v.$$('[data-view]')[1], new window.FocusEvent('focusin', { bubbles: true }) as any);
  assert.deepEqual(ops, [
    { op: 'focus', target: 'primary' },
    { op: 'focus', target: 'b' },
  ]);
  // a page shown alone (Settings, the docked panel) keeps the panes for later, and takes the focus from a hidden one
  await act(async () =>
    (v.$$('[data-view]')[0] as HTMLElement).dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as any),
  );
  assert.equal(store.getState().split.focus, 'a');
  await v.rerender({ splits: false });
  assert.equal(v.$$('.split-pane').length, 1);
  assert.equal(store.getState().split.panes.length, 2);
  assert.equal(store.getState().split.focus, 'primary');
  await v.unmount();
});

test('the header closes its pane and its menu moves it or closes it; a menu that fails changes nothing', async () => {
  layout(['a', 'b']);
  const v = await mount();
  const heads = () => v.$$('.split-pane-head');
  await act(async () => (heads()[1].querySelector('[aria-label="Close split view"]') as HTMLElement).click());
  assert.deepEqual(ops.at(-1), { op: 'close', chatId: 'b' });
  layout(['a', 'b']);
  await act(async () => {});
  const options = (i: number) => heads()[i].querySelector('[aria-label="Split view options"]') as HTMLElement;
  popup = 'right';
  await act(async () => options(0).click());
  assert.deepEqual(
    popupItems.map((i) => i.id ?? i.type),
    ['right', 'separator', 'close'],
  );
  assert.deepEqual(calls.at(-1), ['move', 'a', 1]);
  popup = 'left';
  await act(async () => options(1).click());
  assert.deepEqual(
    popupItems.map((i) => i.id ?? i.type),
    ['left', 'separator', 'close'],
  );
  assert.deepEqual(calls.at(-1), ['move', 'b', -1]);
  popup = 'close';
  await act(async () => options(1).click());
  assert.deepEqual(ops.at(-1), { op: 'close', chatId: 'b' });
  // the only split pane: no move, no separator
  layout(['a']);
  await act(async () => {});
  popup = null;
  await act(async () => options(0).click());
  assert.deepEqual(
    popupItems.map((i) => i.id ?? i.type),
    ['close'],
  );
  const before = ops.length;
  popup = 'fail';
  await act(async () => options(0).click());
  assert.equal(ops.length, before);
  await v.unmount();
});

test('a separator resizes its two panes: a drag paints as it goes and commits on release; arrow keys step', async () => {
  layout(['a']);
  const v = await mount();
  const sep = v.$('.split-sep');
  assert.equal(sep.getAttribute('role'), 'separator');
  assert.equal(sep.getAttribute('aria-valuenow'), '50');
  // two panes over 1800 px: a weight of 1 is 900 px; 180 px is 0.2
  await pointer(sep, 'pointerdown', { clientX: 0 });
  assert.equal(document.documentElement.dataset.edgeDrag, 'column');
  // moves within one frame paint once, at the last
  // dispatched without act, which would let a frame run between them
  for (const clientX of [90, 180])
    sep.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX }) as any);
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1fr) 1px minmax(0, 1fr)', 'nothing painted between frames');
  await frame();
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1.2fr) 1px minmax(0, 0.8fr)');
  assert.equal(ops.length, 0, 'not committed while dragging');
  await pointer(sep, 'pointermove', { clientX: 180, pointerId: 2 });
  await pointer(sep, 'pointerup', { clientX: 180 });
  assert.equal(document.documentElement.dataset.edgeDrag, undefined);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'resize');
  assert.deepEqual(
    (ops[0] as { weights: number[] }).weights.map((w) => Math.round(w * 10) / 10),
    [1.2, 0.8],
  );
  // a cancelled drag goes back; a press that never moved commits nothing
  await pointer(sep, 'pointerdown', { clientX: 0 });
  await pointer(sep, 'pointermove', { clientX: -90 });
  await pointer(sep, 'pointercancel');
  await pointer(sep, 'pointerdown', { clientX: 0 });
  await pointer(sep, 'pointerup', { clientX: 0 });
  await pointer(sep, 'pointerup', { clientX: 0 });
  await pointer(sep, 'pointerdown', { clientX: 0, button: 2 });
  assert.equal(ops.length, 1);
  // the capture lost mid-drag (the window lost the pointer): what was painted is committed
  await pointer(sep, 'pointerdown', { clientX: 0 });
  await pointer(sep, 'pointermove', { clientX: 18 });
  await pointer(sep, 'lostpointercapture');
  assert.equal(ops.length, 2);
  ops.pop();
  layout(['a'], 'primary', [1.2, 0.8]);
  await act(async () => {});
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1.2fr) 1px minmax(0, 0.8fr)');
  // a pane closed mid-drag: the grid shows the layout's columns, not the drag's
  await pointer(sep, 'pointerdown', { clientX: 0 });
  await pointer(sep, 'pointermove', { clientX: 90 });
  await frame();
  layout([]);
  await act(async () => {});
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1fr)');
  assert.equal(document.documentElement.dataset.edgeDrag, undefined, 'the separator gone with its pane takes the lock');
  layout(['a'], 'primary', [1.2, 0.8]);
  await act(async () => {});
  assert.equal(v.$('.split-frame').style.gridTemplateColumns, 'minmax(0, 1.2fr) 1px minmax(0, 0.8fr)', 'no drag widths left behind');
  const sep2 = v.$('.split-sep');
  // keys: Right widens the left pane, other keys are left to others
  await fire(sep2, new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }) as any);
  assert.equal(ops.at(-1)?.op, 'resize');
  const n = ops.length;
  await fire(sep2, new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any);
  // at the minimum, a key moves nothing
  layout(['a'], 'primary', [1.6, 0.4]);
  await act(async () => {});
  await fire(v.$('.split-sep'), new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }) as any);
  assert.equal(ops.length, n);
  await v.unmount();
});

/** A drag event at (x, 10) carrying `data` (its types are the keys), as the sidebar's rows and a pane's header send. */
async function drag(el: Element, type: string, x: number, data: Record<string, string> = {}, relatedTarget: EventTarget | null = null) {
  const dt = {
    types: Object.keys(data),
    effectAllowed: '',
    dropEffect: '',
    setData: (k: string, v: string) => void (data[k] = v),
    getData: (k: string) => data[k] ?? '',
  };
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries({ dataTransfer: dt, clientX: x, clientY: 10, relatedTarget }))
    Object.defineProperty(ev, k, { value: v });
  await fire(el, ev as any);
  return { dt, prevented: ev.defaultPrevented };
}

test('a sidebar chat dragged over the main area shows where it would land, and the drop puts it there', async () => {
  const { CHAT_DRAG } = await import('../src/lib/splitDrop.ts');
  layout(['a']);
  const v = await mount();
  const frame = v.$('.split-frame');
  const badge = () => v.$('.split-drop-badge')?.textContent ?? null;
  // two panes over 1800 px: primary 0-900, a 900-1800, edges 120 px
  const over = await drag(frame, 'dragover', 1750, { [CHAT_DRAG]: 'c' });
  assert.equal(over.prevented, true);
  assert.equal(over.dt.dropEffect, 'move');
  assert.equal(badge(), 'Split view');
  assert.equal(v.$('.split-drop').getAttribute('aria-hidden'), 'true');
  await drag(frame, 'dragover', 1300, { [CHAT_DRAG]: 'c' });
  assert.equal(badge(), 'Open here');
  // leaving for a child is still over it; leaving the frame clears the zone
  await drag(frame, 'dragleave', 1300, { [CHAT_DRAG]: 'c' }, v.$('.page'));
  assert.equal(badge(), 'Open here');
  await drag(frame, 'dragleave', 1300, { [CHAT_DRAG]: 'c' }, document.body);
  assert.equal(badge(), null);
  // something else dragged (a file) is not the frame's
  const file = await drag(frame, 'dragover', 1300, { Files: '' });
  assert.equal(file.prevented, false);
  assert.equal(badge(), null);
  // drops: the middle of a split pane, the primary pane, an edge
  await drag(frame, 'drop', 1300, { [CHAT_DRAG]: 'c' });
  assert.deepEqual(ops.at(-1), { op: 'replace', chatId: 'a', next: 'c' });
  assert.equal(badge(), null);
  layout(['a']);
  await act(async () => {});
  await drag(frame, 'drop', 400, { [CHAT_DRAG]: 'c' });
  await drag(frame, 'drop', 1750, { [CHAT_DRAG]: 'c' });
  assert.deepEqual(calls.slice(-2), [
    ['navigate', { name: 'thread', id: 'c' }],
    ['openInSplit', 'c', 1],
  ]);
  // a drop outside every pane, or with no chat id, does nothing
  const n = calls.length;
  await drag(frame, 'drop', 2400, { [CHAT_DRAG]: 'c' });
  await drag(frame, 'drop', 1750, { [CHAT_DRAG]: '' });
  assert.equal(calls.length, n);
  // a page shown alone (Settings) takes no drops
  await v.rerender({ splits: false });
  assert.equal((await drag(v.$('.split-frame'), 'dragover', 100, { [CHAT_DRAG]: 'c' })).prevented, false);
  await v.unmount();
});

test('a split pane dragged by its header moves at another pane’s edge and swaps in its middle', async () => {
  const { PANE_DRAG } = await import('../src/lib/splitDrop.ts');
  layout(['a', 'b']);
  const v = await mount();
  const frame = v.$('.split-frame');
  const head = v.$$('.split-pane-head')[0];
  assert.equal(head.getAttribute('draggable'), 'true');
  // three panes over 1800 px: 600 each; a is 600-1200, b 1200-1800
  const start = await drag(head, 'dragstart', 700, {});
  assert.equal(start.dt.getData(PANE_DRAG), 'a');
  assert.equal(start.dt.effectAllowed, 'move');
  await drag(frame, 'dragover', 1750, { [PANE_DRAG]: 'a' });
  assert.equal(v.$('.split-drop-badge').textContent, 'Move here');
  await drag(frame, 'dragover', 1500, { [PANE_DRAG]: 'a' });
  assert.equal(v.$('.split-drop-badge').textContent, 'Swap');
  await drag(frame, 'drop', 1500, { [PANE_DRAG]: 'a' });
  assert.deepEqual(ops.at(-1), { op: 'swap', a: 'a', b: 'b' });
  layout(['a', 'b']);
  await act(async () => {});
  await drag(frame, 'drop', 1750, { [PANE_DRAG]: 'a' });
  assert.deepEqual(ops.at(-1), { op: 'move', chatId: 'a', to: 1 });
  // once the drag ends, a pane type alone (another window's drag) names no pane here
  layout(['a', 'b']);
  await act(async () => {});
  assert.equal((await drag(frame, 'dragover', 1500, { [PANE_DRAG]: 'a' })).prevented, true, 'still dragging a: Swap');
  await drag(v.$$('.split-pane-head')[0], 'dragend', 0, {});
  const after = await drag(frame, 'dragover', 1500, { [PANE_DRAG]: 'a' });
  assert.equal(after.prevented, false);
  await v.unmount();
});

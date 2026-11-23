// Dragging the side pane's edge: its limits within its lane, one width per frame for the pane and the title bar's tab
// strip with nothing under the pane rendered again, and the width state set once on release (#2049).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { pointerEvent } from './support/pointerCapture.ts';
import { fakeStore, one, settle } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
import { stubPanels } from './support/side-pane-panels.ts';

const store = fakeStore({ paneTabs: [], paneActive: null, paneFull: false, agentTabs: {}, segments: {} });
const { createElement: h, act } = await import('react');
const stub = (name: string) => () => h('section', { 'data-stub': name });
let diffRenders = 0;
stubStore({ ...store.exports, chatOf: (id: string) => id });
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { DiffPanel: () => (diffRenders++, h('section')) } });
// the remote Files pane draws file glyphs from the diff pane: a chat on this Mac never mounts it
mock.module('../src/components/panels/files/RemoteFiles.tsx', {
  namedExports: { RemoteFilesPanel: () => null, RemoteFilePreview: () => null },
});
stubPanels(stub);
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: stub('term') } });
mock.module('../src/session/harness/claude.ts', { namedExports: { recheckClaude: async () => undefined } });
const { SidePane } = await import('../src/components/panels/SidePane.tsx');
// usePaneSpring's element.animate: an inert stand-in (see sidePaneUI.test.ts)
(globalThis as any).HTMLElement.prototype.animate = () => ({ cancel: () => undefined });
const observers: (() => void)[] = [];
(globalThis as any).ResizeObserver = class {
  constructor(cb: () => void) {
    observers.push(cb);
  }
  observe() {}
  disconnect() {}
};
beforeEach(() => {
  store.calls.length = 0;
  // each test starts with no width chosen before
  store.set({ prefs: {} });
  (window as any).innerWidth = 1600;
});
/** One animation frame: a drag shows its width once per frame (src/lib/edgeDrag.ts). */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

test('a pane rendered outside any lane keeps its window-based width, and drags within the window', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  const frag = document.createDocumentFragment();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(frag as any);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = frag.querySelector('.side-pane') as HTMLElement;
  assert.equal(pane.style.width, '800px');
  const fire = (t: EventTarget, type: string, clientX: number) =>
    act(async () => {
      t.dispatchEvent(type === 'dblclick' ? new (window as any).MouseEvent(type, { bubbles: true }) : pointerEvent(type, { clientX }));
    });
  const edge = pane.querySelector('.pane-resize')!;
  await fire(edge, 'pointerdown', 800);
  await fire(edge, 'pointermove', -2000);
  await frame();
  assert.equal(pane.style.width, '1160px', 'the 1600 window leaves the chat 440');
  await fire(edge, 'pointerup', 0);
  await act(async () => root.unmount());
});

test('dragging the edge resizes the pane between its limits, measured in its lane rather than the window', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  (window as any).innerWidth = 1400;
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  const fire = (t: EventTarget, type: string, clientX: number) =>
    act(async () => {
      t.dispatchEvent(type === 'dblclick' ? new (window as any).MouseEvent(type, { bubbles: true }) : pointerEvent(type, { clientX }));
    });
  const edge = one(host, '.pane-resize');
  await fire(edge, 'pointerdown', 800);
  await fire(edge, 'pointermove', 700);
  await frame();
  assert.equal(pane.style.width, '700px');
  await fire(edge, 'pointermove', 2000);
  await frame();
  assert.equal(pane.style.width, '400px');
  await fire(edge, 'pointermove', -2000);
  await frame();
  assert.equal(pane.style.width, '760px'); // the chat keeps 440 of the 1200 lane, not of the 1400 window
  await fire(edge, 'pointerup', 0);
  await fire(edge, 'pointermove', 700);
  await frame();
  assert.equal(pane.style.width, '760px');
  await fire(one(host, '.pane-resize'), 'dblclick', 0); // back to the default: half the lane, as Claude's panel edge does
  assert.equal(pane.style.width, '600px');
  await act(async () => root.unmount());
  await settle(act);
});

test('a drag renders nothing under the pane: the pane and the tab strip follow each frame, the width state changes on release (#2049)', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  (window as any).innerWidth = 1400;
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  const fire = (t: EventTarget, type: string, clientX: number) =>
    act(async () => {
      t.dispatchEvent(type === 'dblclick' ? new (window as any).MouseEvent(type, { bubbles: true }) : pointerEvent(type, { clientX }));
    });
  const before = diffRenders;
  const edge = one(host, '.pane-resize');
  await fire(edge, 'pointerdown', 800);
  // moves change no React state: dispatched without act, which would let a frame run between them
  for (const x of [790, 760, 720, 700]) edge.dispatchEvent(pointerEvent('pointermove', { clientX: x }));
  assert.equal(pane.style.width, '600px', 'nothing is written between frames');
  await frame();
  assert.equal(pane.style.width, '700px');
  assert.equal(pane.style.getPropertyValue('--pane-w'), '700px');
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 700 }], 'the tab strip takes the width in the same frame');
  await fire(edge, 'pointermove', 650);
  await frame();
  assert.equal(diffRenders, before, 'the Changes pane is not rendered again while the edge moves');
  await fire(edge, 'pointerup', 0);
  assert.equal(pane.style.width, '750px');
  assert.equal(diffRenders, before + 1, 'released: the pane renders once with its new width');
  // a drag the pane unmounts in the middle of stops there: no width written into the gone pane, no state set; a
  // second press while one is under way replaces it
  await fire(edge, 'pointerdown', 800);
  await fire(edge, 'pointerdown', 800);
  edge.dispatchEvent(pointerEvent('pointermove', { clientX: 600 })); // its frame not yet run
  await act(async () => root.unmount());
  store.calls.length = 0;
  await frame();
  await fire(edge, 'pointerup', 0);
  assert.deepEqual(store.calls, []);
  assert.equal(pane.style.width, '750px');
});

test('a window resized mid-drag: the drag keeps the width and tab strip, and fits the new lane (#2049)', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  const host = document.createElement('div');
  let lane = 1200;
  Object.defineProperty(host, 'clientWidth', { get: () => lane });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  observers.length = 0;
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  const edge = one(host, '.pane-resize');
  const move = (clientX: number) => edge.dispatchEvent(pointerEvent('pointermove', { clientX }));
  await act(async () => edge.dispatchEvent(pointerEvent('pointerdown', { clientX: 800 })));
  move(500);
  await frame();
  assert.equal(pane.style.width, '760px', 'the chat keeps 440 of the 1200 lane');
  // the window gets smaller: the pane's observers fire, and leave the drag's width and the strip's alone
  lane = 1000;
  store.calls.length = 0;
  pane.getBoundingClientRect = () => ({ width: 760 }) as DOMRect;
  await act(async () => observers.forEach((cb) => cb()));
  assert.equal(pane.style.width, '760px');
  assert.deepEqual(store.calls, []);
  move(400);
  await frame();
  assert.equal(pane.style.width, '560px', 'the next frame fits the lane as it is now');
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 560 }]);
  await act(async () => edge.dispatchEvent(pointerEvent('pointerup')));
  assert.equal(pane.style.width, '560px');
  // released: the observers follow the pane again
  pane.getBoundingClientRect = () => ({ width: 560 }) as DOMRect;
  await act(async () => observers.forEach((cb) => cb()));
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 560 }]);
  await act(async () => root.unmount());
  await settle(act);
});

test('the width a drag leaves is remembered per kind: the next pane opens at that share of its lane; a double-click forgets it', async () => {
  const { createRoot } = await import('react-dom/client');
  const fire = (t: EventTarget, type: string, clientX: number) =>
    act(async () => {
      t.dispatchEvent(type === 'dblclick' ? new (window as any).MouseEvent(type, { bubbles: true }) : pointerEvent(type, { clientX }));
    });
  const open = async (kind: string, lane: number) => {
    store.set({ paneActive: 'x', paneTabs: [{ id: 'x', kind, threadId: 't1' }], paneFull: false });
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: lane });
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
    return { host, root, pane: one(host, '.side-pane') };
  };
  // a browser pane dragged to 520 of a 1000 lane
  const a = await open('browser', 1000);
  assert.equal(a.pane.style.width, '500px', 'nothing chosen yet: half the lane');
  const edge = one(a.host, '.pane-resize');
  await fire(edge, 'pointerdown', 500);
  await fire(edge, 'pointermove', 480);
  await frame();
  await fire(edge, 'pointerup', 480);
  assert.deepEqual(store.exports.getState().prefs.paneWidths, { wide: 0.52 });
  await act(async () => a.root.unmount());
  // the next wide pane (Changes) in a wider lane opens at the same share; a side chat keeps the default
  const b = await open('changes', 1200);
  assert.equal(b.pane.style.width, '624px', '0.52 of 1200');
  await act(async () => b.root.unmount());
  const c = await open('chat', 1000);
  assert.equal(c.pane.style.width, '500px');
  // a double-click puts the default back and forgets the share, for its kind only
  store.set({ prefs: { paneWidths: { wide: 0.52, narrow: 0.45 } } });
  await act(async () => c.root.unmount());
  const d = await open('tasks', 1000);
  assert.equal(d.pane.style.width, '450px');
  await fire(one(d.host, '.pane-resize'), 'dblclick', 0);
  assert.equal(d.pane.style.width, '500px');
  assert.deepEqual(store.exports.getState().prefs.paneWidths, { wide: 0.52 });
  await act(async () => d.root.unmount());
  await settle(act);
});

test('a pane kept mounted behind (a browser page stays) opens again at the width remembered for the kind then in front', async () => {
  store.set({
    prefs: { paneWidths: { wide: 0.6, narrow: 0.42 } },
    paneActive: 'b',
    paneTabs: [{ id: 'b', kind: 'browser' }],
    paneFull: false,
  });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  assert.equal(pane.style.width, '720px');
  // closed: the pane stays mounted, hidden; a tasks tab in front when it opens again
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1', hidden: true })));
  await act(async () =>
    store.set({
      paneActive: 't',
      paneTabs: [
        { id: 'b', kind: 'browser' },
        { id: 't', kind: 'tasks', threadId: 't1' },
      ],
    }),
  );
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  assert.equal(pane.style.width, '504px');
  await act(async () => root.unmount());
  await settle(act);
});

test('a press released without a move leaves the observers following the pane; only the main button drags', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  observers.length = 0;
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  const edge = one(host, '.pane-resize');
  await act(async () => edge.dispatchEvent(pointerEvent('pointerdown', { button: 2, clientX: 800 })));
  assert.equal(edge.hasPointerCapture(1), false, 'a right press starts nothing');
  await act(async () => edge.dispatchEvent(pointerEvent('pointerdown', { clientX: 800 })));
  assert.equal(edge.hasPointerCapture(1), true);
  await act(async () => edge.dispatchEvent(pointerEvent('pointerup', { clientX: 800 })));
  store.calls.length = 0;
  pane.getBoundingClientRect = () => ({ width: 640 }) as DOMRect;
  await act(async () => observers.forEach((cb) => cb()));
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 640 }]);
  await act(async () => root.unmount());
  await settle(act);
});

test('a release over embedded content ends the drag: the lost capture commits, and the edge stops following the mouse (#3833)', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  (window as any).innerWidth = 1400;
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  const edge = one(host, '.pane-resize');
  await act(async () => edge.dispatchEvent(pointerEvent('pointerdown', { clientX: 800 })));
  await act(async () => edge.dispatchEvent(pointerEvent('pointermove', { clientX: 700 })));
  await frame();
  // the frame took the release: the edge hears no pointerup, only the capture ending at the next move
  await act(async () => edge.dispatchEvent(pointerEvent('lostpointercapture')));
  assert.equal(pane.style.width, '700px');
  assert.equal(document.documentElement.dataset.edgeDrag, undefined);
  await act(async () => edge.dispatchEvent(pointerEvent('pointermove', { clientX: 300 })));
  await act(async () => window.dispatchEvent(new (window as any).MouseEvent('mousemove', { clientX: 300 })));
  await frame();
  assert.equal(pane.style.width, '700px', 'no button held: the width stays');
  await act(async () => root.unmount());
  await settle(act);
});

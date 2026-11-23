// The terminal panel's edge: dragged within limits through a captured pointer, and the column's observer after a press.
import { FakeTerminal } from './support/terminal-ui-fake';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { pointerEvent } from './support/pointerCapture.ts';
import { fakeStore, markdownStub, one, settle, render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ prefs: { codeFontSize: 12, keybindings: {} } });
class FakeFit {
  fit() {}
}
const observers: { cb: () => void; disconnected: boolean }[] = [];
(globalThis as any).ResizeObserver = class {
  entry: { cb: () => void; disconnected: boolean };
  constructor(cb: () => void) {
    this.entry = { cb, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
};
mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeFit } });
mock.module('@xterm/xterm/css/xterm.css', { namedExports: {} });
stubStore(store.exports);
installNativeStub({
  pty: { onEvent: () => () => undefined, spawn: async () => undefined, write() {}, resize() {}, kill: async () => undefined },
});
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: true }) });
const { createElement, act } = await import('react');
const { TerminalPanel } = await import('../src/components/panels/TerminalPanel.tsx');
/** One animation frame: a drag shows its height once per frame (src/lib/edgeDrag.ts). */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

test('a folder without a name titles its tab after the shell; dragging the edge resizes within limits', async () => {
  const r = await render(createElement(TerminalPanel, { cwd: '' }));
  await settle(act);
  assert.equal(one(r.host, '.bottom-tab').textContent, 'zsh');
  const panel = one(r.host, '.bottom-panel');
  const edge = one(r.host, '.bottom-resize');
  const fire = (target: EventTarget, type: string, clientY: number) => target.dispatchEvent(pointerEvent(type, { clientY }));
  (window as any).innerHeight = 900;
  await act(async () => fire(edge, 'pointerdown', 500));
  await act(async () => fire(edge, 'pointermove', 400));
  await frame();
  assert.equal(panel.style.height, '360px');
  await act(async () => fire(edge, 'pointermove', 1000));
  await frame();
  assert.equal(panel.style.height, '120px');
  await act(async () => fire(edge, 'pointermove', -1000));
  await frame();
  assert.equal(panel.style.height, '700px');
  await act(async () => fire(edge, 'pointerup', 0));
  await act(async () => fire(edge, 'pointermove', 400));
  await frame();
  assert.equal(panel.style.height, '700px', 'released drags stop resizing');
});

test('the panel sizes within the column it shares with the chat, and a column that shrinks takes the panel in', async () => {
  const before = observers.length;
  const r = await render(createElement(TerminalPanel, { cwd: '/repo' }));
  await settle(act);
  let column = 1000;
  Object.defineProperty(r.host, 'clientHeight', { configurable: true, get: () => column });
  const panel = one(r.host, '.bottom-panel');
  const edge = one(r.host, '.bottom-resize');
  const fire = (target: EventTarget, type: string, clientY: number) => target.dispatchEvent(pointerEvent(type, { clientY }));
  (window as any).innerHeight = 2000;
  await act(async () => fire(edge, 'pointerdown', 500));
  await act(async () => fire(edge, 'pointermove', -2000));
  await frame();
  assert.equal(panel.style.height, '800px', 'the chat above keeps 200 of the 1000 column, not of the 2000 window');
  await act(async () => fire(edge, 'pointerup', 0));
  // the window gets shorter: the column's observer clamps the panel again
  column = 600;
  const lane = observers.slice(before).filter((o) => !o.disconnected);
  await act(async () => lane.forEach((o) => o.cb()));
  assert.equal(panel.style.height, '400px');
  // a right press starts nothing; a press released without a move leaves the observer clamping
  await act(async () => fire(edge, 'pointerdown', 500));
  await act(async () => fire(edge, 'pointerup', 500));
  await act(async () => edge.dispatchEvent(pointerEvent('pointerdown', { button: 2, clientY: 500 })));
  assert.equal(edge.hasPointerCapture(1), false);
  column = 500;
  await act(async () => lane.forEach((o) => o.cb()));
  assert.equal(panel.style.height, '300px');
  column = 600;
  await act(async () => lane.forEach((o) => o.cb()));
  // a second press replaces a drag under way, and an unmount mid-drag stops it (#2049)
  await act(async () => (fire(edge, 'pointerdown', 500), fire(edge, 'pointerdown', 500)));
  column = 300; // the column's observer leaves a drag's height to the drag (checked below)
  await act(async () => lane.forEach((o) => o.cb()));
  fire(edge, 'pointermove', 400); // its frame not yet run
  await r.unmount();
  await frame();
  await act(async () => fire(edge, 'pointerup', 0));
  assert.equal(panel.style.height, '300px', 'neither the observer nor the gone drag wrote to it');
});

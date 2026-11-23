// Where Popover opens by the room around its anchor (src/components/ui/popoverPlacement.ts): an anchor too high to open above
// opens below rather than clamped over itself, and with room on neither side it stays clamped on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';

const { createElement: h, act } = await import('react');
const { Popover } = await import('../src/components/ui/Popover.tsx');

const HEIGHT = 250;
let height = HEIGHT;
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });

/** The popover's top when it opens from an anchor at `y` (20 px tall) in a window `vh` tall. */
async function openedTop(y: number, vh: number, placement: 'top-start' | 'bottom-start') {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: vh });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  const anchor = document.createElement('button');
  anchor.getBoundingClientRect = () => ({ left: 100, right: 150, top: y, bottom: y + 20, width: 50, height: 20 }) as DOMRect;
  document.body.append(anchor);
  const m = await mount(h(Popover, { anchor, open: true, onClose: () => {}, placement, offset: 8, children: h('span', { id: 'inside' }) }));
  const top = (document.querySelector('#inside')!.parentElement as HTMLElement).style.top;
  await m.unmount();
  anchor.remove();
  return Number.parseFloat(top);
}

test('top-start opens above with room there', async () => {
  assert.equal(await openedTop(500, 800, 'top-start'), 500 - HEIGHT - 8);
});

test('top-start high on screen opens below the anchor, never over it', async () => {
  assert.equal(await openedTop(200, 800, 'top-start'), 200 + 20 + 8);
});

test('top-start with room on neither side stays clamped on screen', async () => {
  assert.equal(await openedTop(100, 300, 'top-start'), 8);
});

test('bottom-start still opens above when it has no room below', async () => {
  assert.equal(await openedTop(700, 800, 'bottom-start'), 700 - HEIGHT - 8);
});

test('below once, it stays below as its content shrinks, until it no longer fits there', async () => {
  height = HEIGHT;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const box = { left: 100, right: 150, top: 200, bottom: 220, width: 50, height: 20 };
  const anchor = document.createElement('button');
  anchor.getBoundingClientRect = () => box as DOMRect;
  document.body.append(anchor);
  const m = await mount(
    h(Popover, { anchor, open: true, onClose: () => {}, placement: 'top-start', offset: 8, children: h('span', { id: 'inside' }) }),
  );
  const top = () => Number.parseFloat((document.querySelector('#inside')!.parentElement as HTMLElement).style.top);
  const placeAgain = () => act(async () => void document.dispatchEvent(new window.Event('scroll')));
  assert.equal(top(), 228);
  // now it would fit above: it doesn't move
  height = 100;
  await placeAgain();
  assert.equal(top(), 228);
  // scrolled too low to fit below: above again
  Object.assign(box, { top: 760, bottom: 780 });
  await placeAgain();
  assert.equal(top(), 760 - 100 - 8);
  await m.unmount();
  anchor.remove();
  height = HEIGHT;
});

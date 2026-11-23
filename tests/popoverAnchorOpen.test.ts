// Popover marks its element anchor while open, so a menu button's down chevron flips up (popovers.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';

const { createElement: h, Fragment } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { Popover } = await import('../src/components/ui/Popover.tsx');
const { ChevronDown } = await import('../src/components/ui/icons.tsx');

const pop = (anchor: any, open: boolean) => h(Popover, { anchor, open, onClose: () => {}, children: h('span', null, 'content') });
const marked = (el: HTMLElement) => el.hasAttribute('data-popover-open');

test('an element anchor is marked while its popover is open and unmarked when it closes or unmounts', async () => {
  const a = document.createElement('button');
  document.body.append(a);
  const m = await mount(pop(a, false));
  assert.equal(marked(a), false);
  await m.render(pop(a, true));
  assert.equal(marked(a), true);
  await m.render(pop(a, false));
  assert.equal(marked(a), false);
  await m.render(pop(a, true));
  await m.unmount();
  assert.equal(marked(a), false);
  a.remove();
});

test('two popovers on one anchor: the mark stays until the last one closes', async () => {
  const a = document.createElement('button');
  document.body.append(a);
  const both = (one: boolean, two: boolean) => h(Fragment, null, pop(a, one), pop(a, two));
  const m = await mount(both(true, true));
  assert.equal(marked(a), true);
  await m.render(both(false, true));
  assert.equal(marked(a), true);
  await m.render(both(false, false));
  assert.equal(marked(a), false);
  await m.unmount();
  a.remove();
});

test('the mark moves with the anchor; a point anchor marks nothing', async () => {
  const a = document.createElement('button');
  const b = document.createElement('button');
  document.body.append(a, b);
  const m = await mount(pop(a, true));
  await m.render(pop(b, true));
  assert.equal(marked(a), false);
  assert.equal(marked(b), true);
  await m.render(pop({ x: 5, y: 5 }, true));
  assert.equal(marked(b), false);
  assert.equal(document.querySelector('[data-popover-open]'), null);
  await m.unmount();
  a.remove();
  b.remove();
});

test('the flip rule targets the class the chevron icon renders with', () => {
  assert.match(renderToStaticMarkup(h(ChevronDown)), /class="[^"]*\blucide-chevron-down\b/);
  const css = readFileSync(new URL('../src/styles/app/popovers.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-popover-open\] > \.lucide-chevron-down \{\s*transform: rotate\(180deg\);/);
});

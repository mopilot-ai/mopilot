// A row opens its submenu, or becomes a list's active row, as the pointer moves over it, never on mouseenter, which
// Chromium sends when the layout moves rows under a still pointer (the model picker's flyout swapped harness on it):
// SubMenu's and useListbox's behavior, and lint/rules/enter-selects.grit, which keeps src off the pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, mount, mouse } from './support/composer-kit.ts';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import { assertRendererRuleAtZero } from './support/lint-rule-kit.ts';

const { createElement: h } = await import('react');
const { Menu, MenuItem, SubMenu, useAnchor } = await import('../src/components/ui/Popover.tsx');

function Harness() {
  const a = useAnchor();
  return h(
    'div',
    null,
    h('button', { id: 'open', ref: a.ref, onClick: a.toggle }, 'open'),
    h(Menu, { anchor: a.anchor, open: a.open, onClose: a.close } as any, h(SubMenu, { label: 'More' } as any, h(MenuItem, null, 'Inner'))),
  );
}

test('SubMenu: a row sliding under a still pointer (mouseover, no move) leaves it shut; the pointer moving opens it', async (t) => {
  const m = await mount(h(Harness));
  t.after(() => m.unmount());
  await click($('#open'));
  const more = $('.menu > .menu-item')!;
  await mouse(more, 'mouseover');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await mouse(more, 'mousemove');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
});

/** The [enter-selects] warnings Biome reports for `input`, written as a .tsx file under src. */
function hits(input: string): number {
  return lintFixtures({ 'src/components/Row.tsx': input }).diagnostics.filter((d) => d.message.includes('[enter-selects]')).length;
}

test('mouseenter that opens a submenu or picks the active row warns; moving, a pass-through and a hover card do not', () => {
  for (const [input, expected] of [
    ['export const E = () => <div className="menu-item" onMouseEnter={() => setIndex(i)} />;', 1],
    ['export const F = () => <div onMouseEnter={() => onHover(i)} />;', 1],
    ['export const G = (i: number) => ({ role: "option", onMouseEnter: () => setIndex(i) });', 1],
    ['export const H = () => <div onMouseMove={() => setIndex(i)} />;', 0],
    ['export const I = ({ onMouseEnter }: any) => <button role="menuitem" onMouseEnter={onMouseEnter} />;', 0],
    ['export const J = () => <div role="button" onMouseEnter={enter} />;', 0],
    ['export const A = () => <button aria-haspopup="menu" onMouseEnter={open} />;', 1],
    [
      'export const B = () => (\n  <MenuRow aria-haspopup="menu" aria-expanded={o} onMouseEnter={open} onClick={open}>\n    x\n  </MenuRow>\n);',
      1,
    ],
    ['export const C = () => <MenuRow aria-haspopup="menu" onMouseMove={open} onMouseLeave={hide} />;', 0],
    ['export const D = () => <div onMouseEnter={highlight}>x</div>;', 0],
  ] as const)
    assert.equal(hits(input), expected, input);
});

test('the rule covers the renderer and starts at zero', () => assertRendererRuleAtZero('./lint/rules/enter-selects.grit'));

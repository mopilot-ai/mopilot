// The model and harness picker's motion (src/styles/app/popovers.css): it opens as the Codex app's model picker
// does (.32s cubic-bezier(.23,1,.32,1) after 30ms, from opacity 0 and scale .98, from the trigger), a change of
// view inside it moves the sections as Codex's picker moves its views (opacity .2s, translate .32s from 10px,
// staggered 56/40ms opening upward; the harness list only fades), and reduced motion turns both off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls, keyframes } = cssRules(css);

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

test("the picker opens with Codex's model-picker timing, from the trigger at its bottom right", () => {
  const p = decls('.popover-layer.picker');
  assert.equal(p.animation, 'picker-open 0.32s cubic-bezier(0.23, 1, 0.32, 1) 30ms both');
  assert.equal(p['transform-origin'], 'bottom right');
  assert.equal(keyframes('picker-open'), 'from{opacity:0;transform:scale(0.98)}');
  // every other popover keeps its own pop-in
  assert.equal(decls('.popover-layer').animation, 'pop-in 150ms var(--ease-enter)');
});

test('a change of view slides the sections: top row from above after 56ms, the slider after 40ms; the list fades', () => {
  assert.equal(decls('.popover-layer.picker.picker-view').animation, 'none');
  const rows = decls('.popover-layer.picker-view .hp-pop > *');
  assert.equal(
    flat(rows.animation),
    'picker-view-fade 0.2s cubic-bezier(0.23, 1, 0.32, 1) var(--picker-view-delay) both, picker-view-move 0.32s cubic-bezier(0.19, 1, 0.22, 1) var(--picker-view-delay) both',
  );
  assert.equal(rows['--picker-view-delay'], '40ms');
  assert.equal(decls('.popover-layer.picker-view .hp-pop > .effort-head')['--picker-view-delay'], '56ms');
  assert.equal(keyframes('picker-view-fade'), 'from{opacity:0}');
  assert.equal(keyframes('picker-view-move'), 'from{translate:0 -10px}');
  // the harness list's rows anchor the Models flyout, placed once as the list appears: they fade without moving
  assert.equal(
    decls('.popover-layer.picker-view .hp-harnesses > *').animation,
    'picker-view-fade 0.2s cubic-bezier(0.23, 1, 0.32, 1) 40ms both',
  );
});

test('with reduced motion the picker and its views appear without motion', () => {
  const off = new Set<string>();
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')) for (const s of r.selectors) off.add(s);
    });
  });
  for (const s of ['.popover-layer.picker', '.popover-layer.picker-view .hp-pop > *', '.popover-layer.picker-view .hp-harnesses > *'])
    assert.ok(off.has(s), s);
});

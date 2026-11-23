// The in-app browser's loading bar (src/styles/app/browser-pane.css): the Codex browser toolbar's 2px bar along its
// bottom edge, faded in and out over 150ms, pulsing with animate-pulse only while shown, still with reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

test("the loading bar is Codex's: 2px on the toolbar's bottom edge, a 150ms fade, the accent at 30%", () => {
  assert.equal(decls('.browser-bar').position, 'relative');
  const bar = decls('.browser-loadbar');
  assert.deepEqual([bar.position, bar.left, bar.right, bar.bottom, bar.height], ['absolute', '0', '0', '0', '2px']);
  assert.equal(bar['pointer-events'], 'none');
  assert.equal(bar.opacity, '0');
  assert.equal(bar.transition, 'opacity 150ms cubic-bezier(0.4, 0, 0.2, 1)');
  assert.equal(decls(".browser-loadbar[data-on='true']").opacity, '1');
  assert.equal(decls('.browser-loadbar > div').background, 'color-mix(in srgb, var(--accent) 30%, transparent)');
});

test('it pulses with animate-pulse only while shown, and holds still with reduced motion', () => {
  assert.equal(decls('.browser-loadbar > div').animation, undefined);
  assert.equal(decls(".browser-loadbar[data-on='true'] > div").animation, 'agent-tab-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite');
  let off = false;
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (
        r.selectors.includes(".browser-loadbar[data-on='true'] > div") &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')
      )
        off = true;
    });
  });
  assert.ok(off);
});

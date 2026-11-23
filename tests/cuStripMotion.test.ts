// The computer-use strip above the composer while the agent works (src/styles/app/control-cards.css): Claude
// Desktop's docked strip, an 8px dot pulsing with Tailwind's animate-pulse and a semibold label, still with
// reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls, keyframes } = cssRules(css);

test("the working strip's dot is Claude Desktop's: 8px, round, animate-pulse (2s, opacity .5 at 50%)", () => {
  const dot = decls('.cu-activity-dot');
  assert.equal(dot.width, '8px');
  assert.equal(dot.height, '8px');
  assert.equal(dot['border-radius'], '50%');
  assert.equal(dot.background, 'var(--accent)');
  assert.equal(dot.animation, 'agent-tab-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite');
  assert.equal(keyframes('agent-tab-pulse'), '50%{opacity:0.5}');
  assert.equal(decls(".cu-activity:is([data-state='active'], [data-state='reading']) .elsewhere-title")['font-weight'], '600');
});

test('with reduced motion the dot holds still', () => {
  let off = false;
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (
        r.selectors.includes('.cu-activity-dot') &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')
      )
        off = true;
    });
  });
  assert.ok(off);
});

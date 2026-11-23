// A box that holds its children at its own width (the sidebar and side pane while they open) clips them and never scrolls.
// Its hairline border leaves the held children a device pixel wider than its content box at 100% scaling; were the box
// a scroll container (overflow: hidden), a focus or scroll-into-view inside it would shift its content by that pixel for
// good, as tests/e2e/browser-blank-tab-recovery.spec.ts saw on Windows. docs/bug-prevention/external-contracts.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

/** Every box whose children a rule holds at a width it reads from a custom property (`X > *… { min-width: …var(--…) }`). */
function holders(): string[] {
  const out = new Set<string>();
  css.walkRules((r) => {
    if (r.parent?.type !== 'root') return;
    const held = r.nodes.some((d) => d.type === 'decl' && d.prop === 'min-width' && /var\(--[\w-]+\)/.test(d.value));
    if (!held) return;
    for (const sel of r.selectors) {
      const m = /^(.+?) > \*(?::not\([^)]*\))?$/.exec(sel);
      if (m) out.add(m[1]);
    }
  });
  return [...out];
}

test('the sidebar and the side pane are the boxes that hold their children at their width', () => {
  assert.deepEqual(holders().sort(), ['.side-pane:not(.full)', '.sidebar']);
});

test('each such box clips its children and is no scroll container, so nothing inside can scroll it sideways', () => {
  for (const box of holders()) assert.equal(decls(box).overflow, 'clip', box);
});

// Step and tool rows' motion (#1511 PR 4c): new rows rise 4px into place (Claude Desktop's step-in), disclosures open over --dur-sheet on the enter curve and close in 150ms ease-out, the sidebar lists keep their own timing, and Presence keeps closed content mounted for the longer of the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';
import { COLLAPSE_MS } from '../src/components/ui/Presence.tsx';

/** prop → value of the first rule outside any at-rule whose selector list is exactly `selector`, in a part of app.css. */
function decls(part: string, selector: string) {
  const out: Record<string, string> = {};
  postcss.parse(readAppCssPart(part)).walkRules((rule) => {
    if (rule.parent?.type !== 'root' || rule.selector.trim() !== selector || Object.keys(out).length) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value.replace(/\s+/g, ' ').trim();
    });
  });
  return out;
}

test('a new row rises 4px into place as it fades in', () => {
  assert.equal(decls('app/thread-messages.css', '.item-enter').animation, 'step-in var(--dur-sheet) ease-out backwards');
  let from = '';
  postcss.parse(readAppCssPart('app/thread-messages.css')).walkAtRules('keyframes', (at) => {
    if (at.params !== 'step-in') return;
    at.walkDecls((d) => {
      from += `${d.prop}:${d.value};`;
    });
  });
  assert.equal(from, 'opacity:0;transform:translateY(4px);');
});

test('disclosures open over --dur-sheet on the enter curve and close in 150ms ease-out', () => {
  assert.equal(decls('app/motion.css', '.collapse').transition, 'grid-template-rows 150ms ease-out, opacity 150ms ease-out');
  assert.equal(
    decls('app/motion.css', '.collapse.open').transition,
    'grid-template-rows var(--dur-sheet) var(--ease-enter), opacity var(--dur-sheet) var(--ease-enter)',
  );
  assert.ok(COLLAPSE_MS >= 300, 'closed content stays mounted at least as long as the longest of the two');
});

test('the sidebar lists keep their own timing, declared after the generic rule so it wins in both states', () => {
  const text = readAppCssPart('app/motion.css');
  assert.equal(
    decls('app/motion.css', '.collapse.side-collapse').transition,
    'grid-template-rows 240ms var(--ease-enter), opacity 180ms ease',
  );
  assert.ok(text.indexOf('.collapse.side-collapse {') > text.indexOf('.collapse.open {'));
});

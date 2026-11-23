// The harness-switch divider's entrance (#1511 PR 4h): a live switch lands with Claude Desktop's chip-in (10px, --dur-sheet, --ease-overshoot) in place of the plain arrival, and reduced motion turns it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';

test('a live switch lands with chip-in in place of the plain arrival; reduced motion turns it off', () => {
  const root = postcss.parse(readAppCssPart('app/harnesses.css'));
  const found: string[] = [];
  root.walkRules((rule) => {
    if (!['.item-enter:has(> .switch-divider)', '.item-enter > .switch-divider'].includes(rule.selector.trim())) return;
    const reduced = rule.parent?.type === 'atrule' && /prefers-reduced-motion:\s*reduce/.test((rule.parent as postcss.AtRule).params);
    rule.walkDecls('animation', (d) => {
      found.push(`${reduced ? 'reduced ' : ''}${rule.selector.trim()} → ${d.value}`);
    });
  });
  assert.deepEqual(found, [
    '.item-enter:has(> .switch-divider) → none',
    '.item-enter > .switch-divider → chip-in var(--dur-sheet) var(--ease-overshoot) backwards',
    'reduced .item-enter > .switch-divider → none',
  ]);
  let from = '';
  root.walkAtRules('keyframes', (at) => {
    if (at.params === 'chip-in') at.walkDecls((d) => void (from += `${d.prop}:${d.value};`));
  });
  assert.equal(from, 'opacity:0;transform:translateY(10px);');
});

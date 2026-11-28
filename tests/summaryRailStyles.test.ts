// The bounded session rail keeps its layout and controls legible with the app's type scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';

const css = postcss.parse(appCss());
function declarations(selector: string) {
  const result: Record<string, string> = {};
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) rule.walkDecls((decl) => void (result[decl.prop] = decl.value));
  });
  return result;
}

test('one surface contains the rail sections with hairline dividers and a compact context meter', () => {
  const panel = declarations('.summary-panel');
  const card = declarations('.summary-panel > *');
  const toggle = declarations('.summary-card-toggle');
  assert.equal(panel['font-size'], 'var(--fs-small)', 'rail typography follows the small UI scale');
  assert.equal(panel.gap, '0');
  assert.equal(panel.border, '1px solid var(--hairline)');
  assert.match(panel.background, /var\(--card-bg\)/);
  assert.equal(card.border, undefined);
  assert.equal(declarations('.summary-panel > * + *')['border-top'], '1px solid var(--hairline)');
  assert.equal(declarations('.summary-changes:has(.summary-change-items:empty):not(:has(.summary-pr-list))').display, 'none');
  assert.equal(declarations('.summary-context meter').flex, 'none');
  assert.ok(Number.parseFloat(toggle['min-height']) <= 36, 'collapsed sections do not become large empty blocks');
  assert.equal(declarations('.summary-subhead')['font-size'], 'var(--fs-micro)');
});

test('the rail bounds its own scroll area and keeps keyboard focus inside card edges', () => {
  const slot = declarations('.summary-slot');
  const panel = declarations('.summary-panel');
  assert.equal(slot['min-height'], '0');
  assert.equal(panel['min-height'], '0');
  assert.equal(panel['overflow-y'], 'auto');
  assert.equal(panel['overflow-x'], 'hidden');
  assert.notEqual(panel['scrollbar-width'], 'none', 'retain native scrollbar access');
  const focus = declarations('.summary-row:focus-visible');
  assert.equal(focus.outline, '2px solid var(--accent)');
  assert.ok(Number.parseFloat(focus['outline-offset']) < 0, 'focus cannot be clipped by the scroller');
});

test('long prose wraps while row labels yield room to icons, counts and actions', () => {
  for (const selector of ['.summary-context-detail', '.summary-note']) {
    assert.equal(declarations(selector)['overflow-wrap'], 'anywhere', selector);
  }
  assert.equal(declarations('.summary-row')['min-width'], '0');
  assert.equal(declarations('.summary-label')['min-width'], '0');
  assert.equal(declarations('.summary-label')['text-overflow'], 'ellipsis');
  assert.equal(declarations('.summary-row > svg').flex, 'none');
  assert.equal(declarations('.summary-row .diff-stat')['font-size'], 'inherit');
  assert.equal(declarations('.summary-track-actions')['flex-wrap'], 'wrap', 'large text must not push form actions outside the card');
});

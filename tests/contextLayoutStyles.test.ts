// The context disclosure keeps its loaded rows and actions readable in a narrow rail at larger text sizes, with usage bars aligned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';

const css = postcss.parse(appCss());
function declarations(selector: string, container = false) {
  const result: Record<string, string> = {};
  css.walkRules((rule) => {
    const parent = rule.parent;
    const inContainer = parent?.type === 'atrule' && parent.name === 'container';
    if (rule.selectors.includes(selector) && inContainer === container) rule.walkDecls((decl) => void (result[decl.prop] = decl.value));
  });
  return result;
}

test('context rows wrap rather than forcing a loaded disclosure wider than its rail', () => {
  for (const selector of ['.ctx-head', '.ctx-figure', '.ctx-compact', '.ctx-foot'])
    assert.equal(declarations(selector)['flex-wrap'], 'wrap', selector);
  assert.equal(declarations('.ctx-compact-text')['overflow-wrap'], 'anywhere');
  assert.equal(declarations('.ctx-compact-btn')['margin-left'], 'auto');
  for (const selector of ['.ctx-legend-row', '.ctx-cost']) {
    assert.equal(declarations(selector)['min-height'], '28px');
    assert.equal(declarations(selector).height, undefined);
  }
  assert.equal(declarations('.ctx-share').width, '3.5em');
});

test('context action links use their natural width and can grow vertically with text', () => {
  const link = declarations('.ctx-foot-link');
  assert.equal(link.flex, '1 1 auto');
  assert.equal(link['min-width'], '0');
  assert.equal(link['min-height'], '40px');
  assert.equal(link.height, undefined);
  assert.equal(declarations('.ctx-compact-btn')['min-height'], '32px');
  assert.equal(declarations('.ctx-compact-btn').height, undefined);
});

test('narrow context panels stack footer actions with a horizontal separator', () => {
  assert.equal(declarations('.ctx-panel')['container-type'], 'inline-size');
  assert.equal(declarations('.ctx-foot', true)['flex-direction'], 'column');
  const separator = declarations('.ctx-foot-link + .ctx-foot-link', true);
  assert.equal(separator['border-left'], 'none');
  assert.equal(separator['border-top'], '1px solid var(--hairline)');
});

test('sidebar bars use shared columns and composer bars span their row at any label or percent width', () => {
  assert.equal(declarations('.limit-row')['grid-template-columns'], 'subgrid');
  assert.equal(declarations('.limit-row')['grid-column'], '1 / -1');
  assert.equal(declarations('.limit-rows')['grid-template-columns'], '104px minmax(0, 1fr) 64px');
  assert.equal(declarations('.limit-row-left')['white-space'], undefined);
  const row = declarations('.composer-plan-windows > .limit-row');
  assert.equal(row['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(row['overflow-wrap'], 'anywhere');
  assert.equal(declarations('.composer-plan-windows .limit-row-bar')['grid-column'], '1 / -1');
  assert.equal(declarations('.composer-plan-windows .limit-row-reset')['grid-column'], '1 / -1');
});

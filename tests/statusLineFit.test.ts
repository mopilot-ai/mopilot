// The running status line's give-way order, which holds at any zoom because it has no widths in it. The geometry itself
// needs a browser: tests/e2e/status-line-zoom.spec.ts measures it in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';

function decls(part: string, selector: string) {
  const out: Record<string, string> = {};
  postcss.parse(readAppCssPart(part)).walkRules((rule) => {
    if (rule.parent?.type !== 'root' || rule.selector.trim() !== selector) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
  });
  return out;
}

test('a toggle claims only its fixed parts, so its words give way before its clock can spill', () => {
  const toggle = decls('app/motion.css', '.claude-step-head > .claude-activity');
  assert.equal(toggle.flex, '1 1 min-content');
  assert.equal(toggle['max-width'], 'max-content');
  assert.equal(toggle['min-width'], undefined, 'min-width: 0 lets the toggle shrink under its clock');
  assert.equal(decls('app/motion.css', '.claude-step-head')['flex-wrap'], 'wrap');
});

test("the words' min-content stays small: a nowrap line would claim its whole text", () => {
  const label = decls('app/motion.css', '.claude-activity-label');
  assert.equal(label['white-space'], undefined);
  assert.equal(label['overflow-wrap'], 'anywhere');
  assert.equal(label['-webkit-line-clamp'], '1');
  assert.equal(label.flex, '1 1 min-content');
  assert.equal(label['min-width'], '6ch', 'a floor in type units, so what follows wraps before the words are unreadable');
});

test('every line with counts wraps them instead of running past the pane', () => {
  assert.equal(decls('tasks-pane.css', '.tasks-count-inline')['flex-wrap'], 'wrap');
  assert.equal(decls('tasks-pane.css', '.tasks-count-inline')['min-width'], '0');
  const row = decls('tasks-pane.css', '.tasks-status-row');
  assert.equal(row['flex-wrap'], 'wrap');
  assert.equal(row.height, undefined, 'a fixed height would clip a wrapped line');
  assert.equal(decls('app/motion.css', '.claude-activity:not(.expandable)')['flex-wrap'], 'wrap');
  assert.equal(decls('app/thread-steps.css', '.step-row:has(> .tasks-count-inline)')['flex-wrap'], 'wrap');
});

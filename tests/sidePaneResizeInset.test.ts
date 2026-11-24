import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';
import postcss from 'postcss';

const css = postcss.parse(appCss());

const px = (selector: string, prop: string) => {
  let value = Number.NaN;
  css.walkRules(selector, (rule) =>
    rule.walkDecls(prop, (d) => {
      value = Number.parseFloat(d.value);
    }),
  );
  return value;
};

test('the browser page leaves the side pane resize handle uncovered along its full height', () => {
  const handleInside = px('.pane-resize', 'width') + px('.pane-resize', 'left');
  assert.ok(handleInside > 0, 'handle reaches into the pane');
  assert.ok(px('.side-pane:not(.full) .browser-stage', 'margin-left') >= handleInside);
});

test("the side pane resize handle is as wide as Codex's 12px split handle, most of it over the chat", () => {
  const width = px('.pane-resize', 'width');
  assert.ok(width >= 12, `a ${width}px strip is hard to land on`);
  assert.ok(-px('.pane-resize', 'left') >= width / 2, 'at least half of it lies outside the pane');
});

test("the pane's clip leaves the part of the handle over the chat in reach", () => {
  assert.ok(px('.side-pane:not(.full)', 'overflow-clip-margin') >= -px('.pane-resize', 'left'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';
import postcss from 'postcss';

const css = postcss.parse(appCss());

test('the browser page leaves the side pane resize handle uncovered along its full height', () => {
  let handleInside = 0;
  let inset = '';
  css.walkRules('.pane-resize', (rule) =>
    rule.walkDecls('left', (d) => {
      handleInside = 6 + Number.parseFloat(d.value);
    }),
  );
  css.walkRules('.side-pane:not(.full) .browser-stage', (rule) =>
    rule.walkDecls('margin-left', (d) => {
      inset = d.value;
    }),
  );
  assert.ok(handleInside > 0, 'handle reaches into the pane');
  assert.ok(Number.parseFloat(inset) >= handleInside);
});

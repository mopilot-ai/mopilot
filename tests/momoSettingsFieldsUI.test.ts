// MoMo's Settings fields as drawn (#2504): the time field is as wide as its value, and the Memory documents have a visible edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

test('the quiet-hours time field sizes to its value, so "07:23 PM" is not cut to "07:23 P"', () => {
  const time = decls('.momo-time.text-input.slim');
  assert.equal(time.width, 'auto');
  assert.ok(Number.parseInt(time['min-width'], 10) >= 96);
});

test('a Memory document has its own hairline edge and a fill, in both themes (its section has no card box)', () => {
  const doc = decls('.momo-doc');
  assert.match(doc.border, /^1px solid var\(--hairline-strong\)$/);
  assert.match(doc.background, /^rgba\(var\(--ink\), 0\.0\d+\)$/);
  assert.notEqual(doc['border-radius'], '0');
});

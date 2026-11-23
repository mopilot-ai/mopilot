// The in-app browser toolbar's box (src/styles/app/browser-pane.css): the Codex browser toolbar's h-12, gap-1.5 and
// px-2 py-2 at compact density, so its 32px controls and address capsule sit centred in 48px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

test("the toolbar is the Codex browser toolbar's: 48px tall, 8px padding, 6px between controls", () => {
  const bar = decls('.browser-bar');
  assert.equal(bar.display, 'flex');
  assert.equal(bar['align-items'], 'center');
  assert.equal(bar.height, '48px');
  assert.equal(bar.padding, '8px');
  assert.equal(bar.gap, '6px');
});

test('the address capsule gives way in a narrow pane, so the buttons stay on the toolbar (#3988)', () => {
  assert.equal(decls('.browser-addr')['min-width'], '0');
});

test('its controls and the address capsule are 32px, which the padding leaves inside 48px', () => {
  for (const sel of ['.browser-navgroup', '.browser-btn.round', '.browser-addr']) assert.equal(decls(sel).height, '32px', sel);
  assert.equal(decls('.browser-addr')['border-radius'], '9999px');
  assert.equal(48 - 2 * 8, 32);
});

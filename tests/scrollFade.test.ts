// Scrolling lists fade an edge only while more content lies beyond it (src/styles/app/scroll-fade.css), as Claude
// Desktop's .scroll-fade-y does: the project menu and shell/tool output no longer keep a static bottom fade that hides
// the last row once the list is scrolled to its end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';

const css = appCss();

test('no scrolling list keeps a static bottom fade; its edges fade with the scroll instead', () => {
  assert.ok(css.includes('@keyframes scroll-fade-bottom'), 'scroll-fade.css is part of the app stylesheet');
  assert.doesNotMatch(css, /\.(?:menu-scroll|shell-scroll)[^{]*\{[^}]*mask-image: linear-gradient\(to bottom, black calc\(100%/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarWidth } from '../src/lib/sidebarWidth.ts';
import { appCss } from './support/app-css.ts';
test('corrupt saved widths and extreme drags cannot leave an open sidebar as a sliver', () => {
  for (const width of [0, -20, 12, 199]) assert.equal(sidebarWidth(width), 200);
  for (const width of [undefined, null, NaN, Infinity, '12']) assert.equal(sidebarWidth(width), 288);
  assert.equal(sidebarWidth(10000), 560);
  assert.equal(sidebarWidth(310), 310);
  assert.equal(sidebarWidth(500, 644), 204);
  // beside a side pane the saved width also leaves the pane its minimum
  assert.equal(sidebarWidth(560, 1440), 560);
  assert.equal(sidebarWidth(560, 1384, 400), 544);
  assert.equal(sidebarWidth(0, 480), 200);
});
test('opening the sidebar animates opacity without temporarily collapsing its layout width', () => {
  const css = appCss();
  const animation = /\.sidebar \{\s*animation: ([^;]+);/.exec(css)?.[1];
  assert.match(animation ?? '', /^fade-in /);
});

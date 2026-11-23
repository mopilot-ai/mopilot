// The popup-tab-lifetime lint guard (lint/rules/popup-tab-lifetime.grit): a popup shown as a tab (createWindow) whose
// lifetime is tied to its opener warns; a tab that outlives its opener, or a native popup window tied to it, does not (#1777).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a popup tab tied to its opener warns; one that outlives it, or a native popup window, does not', () => {
  for (const [input, expected] of [
    // windows.cjs before #1777
    ["export const p = (open) => ({ action: 'allow', outlivesOpener: false, createWindow: (o) => open(o) });", 1],
    ['export const p = (open) => ({ createWindow: open, outlivesOpener: false });', 1],
    ["export const p = (open) => ({ action: 'allow', outlivesOpener: true, createWindow: (o) => open(o) });", 0],
    ["export const p = (open) => ({ action: 'allow', createWindow: open });", 0],
    ['export const p = (open) => ({ createWindow: open, outlivesOpener: !1 });', 1],
    // an OAuth popup window stays tied to the tab that opened it
    ["export const p = () => ({ action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: { width: 560 } });", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/capabilities/browser/policy.cjs': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[popup-tab-lifetime]'));
    assert.equal(hits.length, expected, input);
  }
});

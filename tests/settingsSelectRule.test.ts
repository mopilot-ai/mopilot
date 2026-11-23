// The settings-select lint guard (lint/rules/settings-select.grit): an E2E spec that clicks a Settings select's
// .select-btn itself warns, since a row that moves under the click opens nothing (#1822); the shared fixture that opens
// it until its option shows, and code outside the E2E specs, do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('an E2E spec opening a Settings select by its .select-btn warns; the shared fixture and other code do not', () => {
  const click = "export const open = (page) => page.locator('.settings-row', { hasText: 'Notifications' }).locator('.select-btn').click();";
  for (const [file, input, expected] of [
    // notifications.spec.ts and cuj-use-my-chrome's fixture before #1822
    ['tests/e2e/notifications.spec.ts', click, 1],
    ['tests/e2e/fixtures/preferredBrowser.ts', 'export const b = (page) => page.locator(".settings-row .select-btn");', 1],
    ['tests/e2e/fixtures/settings.ts', click, 0],
    ['tests/e2e/notifications.spec.ts', "export const open = (page) => chooseSetting(page, 'Notifications', 'Never');", 0],
    ['tests/e2e/x.spec.ts', "export const b = (page) => page.locator('.select-btn-row');", 0],
    ['src/components/x.ts', "export const b = '.select-btn';", 0],
  ] as const) {
    const report = lintFixtures({ [file]: input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[settings-select]'));
    assert.equal(hits.length, expected, `${file}: ${input}`);
  }
});

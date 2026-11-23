// Codex's typed commands and the / menu share one registry (WP7-5): the menu has an App group of Sage's
// own commands, an alias runs its command, an unknown command offers plain text, /exit is never sent.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const slash = (page: Page) => page.locator('.slash-panel');

test.use({ harnesses: 'codex' });

test('the / menu has an App group; /clear runs /new; unknown and /exit never reach Codex as commands', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('first message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-codex: first message', { exact: true })).toBeVisible();

  await composer(page).fill('/');
  const settings = slash(page).locator('.add-panel-item', { hasText: '/settings' });
  await expect(settings).toBeVisible();
  await expect(settings.locator('.add-panel-scope')).toHaveText('App');
  await expect(slash(page).getByText('/diff')).toBeVisible();
  await composer(page).fill('/se');
  await expect(slash(page).locator('.add-panel-item')).toHaveCount(1);

  // an unknown command is a note with a way to send it anyway
  await composer(page).fill('/frobnicate now');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status').getByText("Codex doesn't have this command")).toBeVisible();
  await page.getByRole('button', { name: 'Send as plain text' }).click();
  await expect(page.getByRole('main').getByText('fake-codex: /frobnicate now', { exact: true })).toBeVisible();

  await composer(page).fill('/exit');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText("/exit isn't sent")).toBeVisible();
  await expect(composer(page)).toHaveText('/exit');

  await composer(page).fill('/clear');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  expect(JSON.stringify(harness.codexLog())).not.toContain('"/exit"');
});

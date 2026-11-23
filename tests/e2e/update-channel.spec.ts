// About → Update channel: the dogfood option is only for internal MoPilot accounts.
import { test, expect } from './fixtures/app';
import { openSettingsSelect, settingsEntry } from './fixtures/settings';

test('update-channel: a signed-out user sees Stable and Beta but not Dogfood', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'About' }).click();
  await openSettingsSelect(page, 'Update channel', 'Beta');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Stable' })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Dogfood' })).toHaveCount(0);
});

test('about: View notices opens the shipped third-party notices file', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // never open a real editor from the test
  await harness.app.evaluate(({ shell }) => {
    (globalThis as any).__opened = [];
    shell.openPath = async (p: string) => ((globalThis as any).__opened.push(p), '');
  });
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'About' }).click();
  await page.locator('.settings-row', { hasText: 'Third-party notices' }).getByRole('button', { name: 'View notices' }).click();
  await expect
    .poll(() => harness.app.evaluate(() => (globalThis as any).__opened as string[]))
    .toEqual([expect.stringMatching(/THIRD_PARTY_NOTICES\.md$/)]);
});

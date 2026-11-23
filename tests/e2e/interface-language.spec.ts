// Settings → General → Language, in the real app: a pick renames the interface once the window reloads, built with the transform.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { chooseSetting, settingsEntry } from './fixtures/settings';

const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../shared/i18n/locales/zh-Hans.json'), 'utf8'));

test('interface-language: a window that reloads after a pick shows that language, and nothing reloads by itself', async ({ page }) => {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await chooseSetting(page, 'Language', '简体中文');
  const row = page.locator('.settings-row', { hasText: 'Language' });

  // the pick alone changes nothing on this page
  await expect(row).toContainText('Language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await row.getByRole('button', { name: 'Reload window' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('textbox', { name: zh.Message, exact: true })).toBeVisible();
});

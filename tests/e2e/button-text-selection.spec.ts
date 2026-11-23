// About's buttons resist native mouse selection while descriptions and text fields remain selectable.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openSettingsSection, settingsEntry } from './fixtures/settings';

for (const fontSize of [14, 24]) {
  test.describe(`button selection at ${fontSize}px`, () => {
    test.use({
      harnesses: 'both',
      // zoomLevel keeps 24 a chat font size: alone it migrates to a 1.7x zoom, which hides the sidebar here (#4158)
      seed: { uiState: { prefs: { fontSize, zoomLevel: 0 } } },
      mainRequire: [path.join(__dirname, 'fixtures', 'update-hook.cjs')],
    });

    test('About button labels cannot be selected by double click or dragging', async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
      await openSettingsSection(page, 'about');
      const button = page.getByRole('button', { name: 'Check for updates', exact: true });
      await expect(button).toBeEnabled();
      await expect(button).toHaveCSS('user-select', 'none');
      const dropdownLabel = page.locator('.settings-row', { hasText: 'Update channel' }).locator('.select-label');
      await expect(dropdownLabel).toHaveCSS('user-select', 'none');

      const description = page.locator('.settings-row', { hasText: 'Update automatically' }).locator('.settings-row-desc');
      await description.click({ clickCount: 3 });
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Download new versions');
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      await button.dblclick();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
      const box = (await button.boundingBox())!;
      await page.mouse.move(box.x + 5, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
      await page.screenshot({ path: test.info().outputPath('about-button-unselected.png') });

      const search = page.getByRole('textbox', { name: 'Search settings', exact: true });
      await search.fill('About');
      await search.selectText();
      expect(await search.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('About');
    });
  });
}

test.describe('nested question labels', () => {
  test.use({ harnesses: 'claude' });

  test('question choices stay unselectable while the question itself remains copyable', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('ASKMULTI now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const question = page.locator('.question-card');
    const choice = question.getByRole('button', { name: 'a.ts', exact: true });
    await expect(choice.locator('.question-option-copy')).toHaveCSS('user-select', 'none');
    await choice.dblclick();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
    await question.locator('.question-title').click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Which files?');
  });
});

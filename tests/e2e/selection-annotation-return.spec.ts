// An annotation's marker over its quoted reply survives leaving the chat and coming back, and deletes from its own bar.
import { test, expect } from './fixtures/app';

for (const family of [
  { label: 'Codex', harnesses: 'codex', defaultHarness: 'codex' },
  { label: 'Claude Code', harnesses: 'claude', defaultHarness: 'claude' },
] as const) {
  test.describe(`annotation on ${family.label}`, () => {
    test.use({ harnesses: family.harnesses, seed: { uiState: { prefs: { defaultHarness: family.defaultHarness } } } });

    test('the marker is back after switching chats, and Delete removes the annotation', async ({ page }, testInfo) => {
      const main = page.locator('.main-content');
      const composer = main.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('Quote a sentence from this reply.');
      await main.getByRole('button', { name: 'Send', exact: true }).click();
      const source = main.locator('.assistant-message > [data-selection-source]').last();
      await expect(source).toContainText('Quote a sentence');
      await main.getByRole('button', { name: 'Fork chat from here', exact: true }).last().waitFor();
      await source.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.getByRole('button', { name: 'Reply' }).click();
      const comment = page.getByPlaceholder('Add an optional comment…');
      await comment.fill('Keep this');
      await comment.press('Enter');
      const marker = page.getByRole('button', { name: 'Edit annotation 1', exact: true });
      await expect(marker).toBeVisible();

      // leave for a new chat and come back: the harness may show the reply again under new item ids
      await page.getByRole('button', { name: 'New chat' }).first().click();
      await expect(marker).toHaveCount(0);
      await page.getByRole('complementary').locator('.thread-row').first().click();
      await expect(source).toContainText('Quote a sentence');
      await expect(main.locator('.selection-chip')).toContainText('1 annotation');
      await expect(marker).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('marker-after-return.png') });

      await marker.click();
      await expect(comment).toHaveValue('Keep this');
      await page.getByRole('button', { name: 'Delete annotation', exact: true }).click();
      await expect(comment).toHaveCount(0);
      await expect(marker).toHaveCount(0);
      await expect(main.locator('.selection-chip')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('after-delete.png') });
    });
  });
}

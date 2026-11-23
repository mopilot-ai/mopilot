// Reopening a hidden pane restores its selected tab; explicit tab creation and the empty state stay separate on every harness.
import { test, expect, sendAppCommand } from './fixtures/app';

for (const family of ['codex', 'claude', 'acp'] as const)
  for (const fontSize of [14, 24])
    test.describe(`Pane restore on ${family} at font ${fontSize}`, () => {
      test.skip(process.platform !== 'darwin' && family === 'acp', 'ACP admission needs sage-mcp on macOS');
      test.use({
        harnesses: family === 'acp' ? 'none' : family,
        acp: family === 'acp' ? { kimi: {} } : {},
        seed: { uiState: { prefs: { fontSize, zoomLevel: 0 } } },
      });

      test('hide and reopen retain the selected tab while New tab always creates one', async ({ page, harness }, testInfo) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1024, height: 682 });
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill('pane restoration');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.assistant-message')).toContainText(`fake-${family}: pane restoration`);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

        const strip = page.locator('.tb-tabs');
        const tabs = strip.locator('.tb-tab-list > .tb-tab');
        const add = strip.locator(':scope > .tooltip-anchor > button[aria-label="New tab"]');
        const show = page.getByRole('button', { name: 'Show tabs', exact: true });
        await page.locator('.titlebar-right').getByRole('button', { name: 'New tab', exact: true }).click();
        for (const title of ['Selected', 'Newer']) {
          await strip.locator('.tb-tab.active').click({ button: 'right' });
          await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
          const input = page.getByRole('textbox', { name: 'Tab name', exact: true });
          await input.fill(title);
          await input.press('Enter');
          if (title === 'Selected') await add.click();
        }
        const selected = strip.getByRole('button', { name: 'Selected', exact: true });
        await selected.click();
        await expect(tabs).toHaveCount(2);
        await strip.getByRole('button', { name: 'Enter full view', exact: true }).click();
        for (let n = 0; n < 3; n++) {
          await strip.getByRole('button', { name: 'Hide tabs', exact: true }).click();
          await expect(strip).toHaveCount(0);
          await expect(show).toBeVisible();
          await expect(page.locator('.titlebar-right').getByRole('button', { name: 'New tab', exact: true })).toHaveCount(0);
          await show.click();
          await expect(tabs).toHaveCount(2);
          await expect(selected).toHaveAttribute('aria-current', 'true');
          await expect(strip.getByRole('button', { name: 'Enter full view', exact: true })).toBeVisible();
        }
        await page.screenshot({ path: testInfo.outputPath(`restored-${family}-${fontSize}.png`) });

        // The native Cmd+T/menu command still creates a tab while the pane is hidden.
        await strip.getByRole('button', { name: 'Hide tabs', exact: true }).click();
        await sendAppCommand(harness, 'open-browser-tab');
        await expect(tabs).toHaveCount(3);
        await expect(selected).not.toHaveAttribute('aria-current', 'true');
        await add.click();
        await expect(tabs).toHaveCount(4);

        await selected.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click();
        await expect(tabs).toHaveCount(1);
        await selected.getByRole('button', { name: 'Close Selected tab', exact: true }).click();
        await expect(strip).toHaveCount(0);
        await expect(show).toHaveCount(0);
        await page.locator('.titlebar-right').getByRole('button', { name: 'New tab', exact: true }).click();
        await expect(tabs).toHaveCount(1);
      });
    });

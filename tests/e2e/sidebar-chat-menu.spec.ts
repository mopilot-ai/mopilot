// The sidebar menu's real popup path: matching entry points, local letters, inline rename and confirmed deletion.
import { test, expect } from './fixtures/app';

const ID = '019c0000-0000-7000-8000-000000000081';
for (const fontSize of [14, 24]) {
  test.describe(`sidebar chat menu at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: [{ id: ID, name: 'Menu keyboard check', turns: ['A saved chat'] }],
        uiState: { summaryOpen: true, prefs: { fontSize, zoomLevel: 0 } },
      },
    });

    test('ellipsis and right-click share local letter actions without opening the chat', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const sidebar = page.getByRole('complementary');
      const recents = sidebar.locator('.sidebar-section').filter({ has: page.getByRole('button', { name: 'Recents', exact: true }) });
      const row = recents.locator(`[data-sidebar-chat="${ID}"]`);
      await expect(row).toBeVisible();
      await row.hover();
      await row.getByRole('button', { name: 'More options', exact: true }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeFocused();
      const initial = await menu.locator('.menu-label').allTextContents();
      expect(initial.length).toBeLessThanOrEqual(8);
      expect(initial).toEqual(['Open in', 'Pin', 'Mark as unread', 'Rename', 'Fork', 'Archive', 'Delete']);
      await expect(menu.locator('.menu-shortcut')).toHaveText(['P', 'U', 'R', 'F', 'A', 'D']);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-menu-font${fontSize}.png`) });
      await page.keyboard.press('Escape');
      await row.click({ button: 'right' });
      await expect(menu).toBeFocused();
      expect(await menu.locator('.menu-label').allTextContents()).toEqual(initial);
      await page.keyboard.press('p');
      await expect(menu).toHaveCount(0);
      await expect(sidebar.locator('.side-label', { hasText: 'Pinned' })).toBeVisible();
      await row.click({ button: 'right' });
      await expect(menu).toBeFocused();
      await page.keyboard.press('u');
      await expect(menu).toHaveCount(0);
      await page.mouse.move(900, 50);
      await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
      await expect(row.locator('.row-dot.unread')).toBeVisible();
      await expect(row).not.toHaveClass(/selected/);
      await row.hover();
      await row.getByRole('button', { name: 'More options', exact: true }).click();
      await expect(menu).toBeFocused();
      await page.keyboard.press('r');
      const rename = row.getByRole('textbox');
      await rename.fill('Renamed using the menu');
      await rename.press('Enter');
      await expect(row).toContainText('Renamed using the menu');
      page.once('dialog', (dialog) => dialog.dismiss());
      await row.click({ button: 'right' });
      await expect(menu).toBeFocused();
      await page.keyboard.press('d');
      await expect(menu).toHaveCount(0);
      await expect(row).toBeVisible();
      page.once('dialog', (dialog) => dialog.accept());
      await row.click({ button: 'right' });
      await expect(menu).toBeFocused();
      await page.keyboard.press('d');
      await expect(sidebar.locator(`[data-sidebar-chat="${ID}"]`)).toHaveCount(0);
    });
  });
}

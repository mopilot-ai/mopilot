// A new chat's Run on chip in the real renderer for an invited account (an unpackaged build's dev invite, MOPILOT_HOST_DEV=1): it sits in the context bar after the project chip (the composer footer has no host chip on Home), opens My machines, offers Add machine (it opens the Add a machine sheet in place over the new chat) and keeps Switch host disabled with its reason; a picker only: no header sentence, and a machine where everything works is one line.
import { test, expect } from './fixtures/app';
import { THEMES, shoot, themeSeed } from './fixtures/shoot';

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ harnesses: 'claude', env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.cloud=0' }, seed: { uiState: themeSeed(theme) } });

    test('Run on chip: this Mac online, menu rows, disabled actions, keyboard close', async ({ page }) => {
      const chip = page.getByRole('button', { name: 'Run on: This Mac, online', exact: true });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveClass(/\bhost-ctx\b/);
      await expect(chip.locator('.host-name')).toHaveText('This Mac');
      // the one place a new chat picks where it runs: in the context bar after the project chip, not in the composer footer
      const order = await page
        .locator('.ctxbar')
        .evaluate((bar) => [...bar.querySelectorAll('button.ctx-btn')].map((b) => (b.classList.contains('host-ctx') ? 'run-on' : 'other')));
      expect(order.indexOf('run-on')).toBe(1);
      await expect(page.locator('.composer-left button.host-chip')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Host: / })).toHaveCount(0);
      await shoot(page, 'host-chip-closed', { clip: (await page.locator('.composer-wrap').boundingBox())! });
      await chip.click();
      const menu = page.getByRole('menu', { name: 'My machines' });
      // one surface like the permission picker: the list is not a second card inside the menu
      await expect(page.locator('.popover-layer .menu')).toHaveCount(1);
      await expect(menu.locator('xpath=ancestor::*[contains(@class,"menu")]')).toHaveCount(1);
      await expect(menu.locator('.menu-title')).toHaveText(['This Mac', 'Add machine…', 'Switch host…']);
      await expect(menu.getByRole('menuitemradio', { name: /This Mac/ })).toHaveAttribute('aria-checked', 'true');
      const add = menu.getByRole('menuitem', { name: /Add machine/ });
      await expect(add).not.toHaveAttribute('aria-disabled', 'true');
      const sw = menu.getByRole('menuitem', { name: /Switch host/ });
      await expect(sw).toHaveAttribute('aria-disabled', 'true');
      await expect(sw).toHaveAttribute('title', 'Send a message first');
      // a picker only: no header sentence, and This Mac (everything works) is one line
      await expect(page.locator('.host-menu .perm-mode-note')).toHaveCount(0);
      await expect(menu.getByRole('menuitemradio', { name: /This Mac/ }).locator('.menu-desc')).toHaveCount(0);
      await shoot(page, 'host-chip-open');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });

    test('Add machine… opens the Add a machine sheet in place over the new chat, and closing it returns to the chat', async ({ page }) => {
      await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
      await page
        .getByRole('menu', { name: 'My machines' })
        .getByRole('menuitem', { name: /Add machine/ })
        .click();
      const sheet = page.locator('.dialog').filter({ has: page.locator('.dialog-head', { hasText: 'Add a machine' }) });
      await expect(sheet.locator('.add-machine-sheet')).toBeVisible();
      await expect(sheet.getByLabel('Machine', { exact: true })).toBeVisible();
      await expect(sheet.getByRole('tab')).toHaveCount(0);
      // the route stays: Settings did not open, the new chat is behind the sheet
      await expect(page.getByRole('region', { name: 'Machines' })).toHaveCount(0);
      await expect(page.locator('.ctxbar')).toBeVisible();
      await expect(page.locator('.composer-wrap')).toBeVisible();
      await shoot(page, 'host-add-machine');
      await sheet.locator('.dialog-head').getByRole('button', { name: 'Close' }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Run on: This Mac, online', exact: true })).toBeVisible();
    });
  });
}

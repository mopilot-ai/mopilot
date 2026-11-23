// Rebinding a menu-backed shortcut moves the native menu accelerator (#60).
import type { ElectronApplication } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the shortcuts are macOS’s: the Command key and its menu glyphs');

const accelerator = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined =>
      items.map((i) => (i.label === label ? i : i.submenu ? find(i.submenu.items) : undefined)).find(Boolean);
    return find(Menu.getApplicationMenu()!.items)?.accelerator ?? null;
  }, label);

test('keybindings: a rebound or removed shortcut changes the menu accelerator', async ({ harness, page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  expect(await accelerator(harness.app, 'New Chat')).toBe('CmdOrCtrl+N');

  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Keyboard shortcuts' }).click();
  const row = page.locator('.settings-row', { hasText: 'Start a new chat' }).filter({ hasNotText: 'outside' });
  await row.getByRole('button').first().click();
  await expect(row.getByText('Press keys…')).toBeVisible();
  await page.keyboard.press('Shift+Meta+KeyX');
  await expect(row.locator('kbd')).toHaveText('⇧⌘X');
  await expect.poll(() => accelerator(harness.app, 'New Chat')).toBe('Shift+CmdOrCtrl+X');

  // removing it leaves the menu item without a key
  await row.getByRole('button', { name: 'Remove shortcut' }).click();
  await expect(row.getByText('Unassigned')).toBeVisible();
  await expect.poll(() => accelerator(harness.app, 'New Chat')).toBe(null);
});

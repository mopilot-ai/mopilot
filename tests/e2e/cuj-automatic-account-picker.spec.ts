// Automatic account selection in a new chat and when switching an existing chat to Codex.
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';
import { openHarnessList } from './fixtures/harnessPicker';

test.use({ harnesses: 'both', env: { SAGE_NO_RELAY: '' }, seed: { files: (d) => twoCodexAccounts(d) } });

test('multiple accounts offer Automatic in a new chat and a harness switch', async ({ page }) => {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  const defaultAutomatic = page.getByRole('menuitemradio', { name: /Automatic.*switching for all chats/ });
  const account = (email: string) => page.getByRole('menuitemradio', { name: new RegExp(email) });
  // exactly one row is checked and shows the mark: Automatic, or one account (models keep their own check)
  const list = page.locator('.menu', { has: defaultAutomatic });
  const expectOnlyChecked = async (row: Locator) => {
    await expect(list.locator('[aria-checked="true"]:not(.hp-models *)')).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-checked', 'true');
    await expect(list.locator('.menu-check svg:not(.hp-models *)')).toHaveCount(1);
    await expect(row.locator('.menu-check svg')).toBeVisible();
  };
  await expect(defaultAutomatic).toBeVisible();
  await expectOnlyChecked(defaultAutomatic);
  await account('second@example.test').click();
  await expectOnlyChecked(account('second@example.test'));
  await defaultAutomatic.click();
  await expectOnlyChecked(defaultAutomatic);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-claude: hello', { exact: true })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  const automatic = page.getByRole('menuitemradio', { name: /Automatic.*Moves to another account/ });
  await expect(automatic).toBeVisible();
  await automatic.click();
  await expect(page.locator('.switch-sheet')).toContainText('Account: Automatic');
  await page.locator('.switch-sheet').getByRole('button', { name: 'Switch', exact: true }).click();
  await composer.fill('continue');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(/fake-codex:/)).toBeVisible();
});

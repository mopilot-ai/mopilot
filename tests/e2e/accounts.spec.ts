// Several Codex accounts, in the real app against tests/e2e/fixtures/fake-codex.mjs. The accounts are
// seeded into the throwaway profile: the CLI's own login and one added account with its own home.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';
import { settingsEntry } from './fixtures/settings';

async function openAccounts(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Accounts & billing' }).click();
}
const row = (page: Page, email: string) => page.locator('.acct-row', { hasText: email });

test.use({ seed: { files: (d) => twoCodexAccounts(d) } });

test('accounts: /logout opens Accounts & billing on the account the chat is on', async ({ page }) => {
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('/logout');
  await page.keyboard.press('Enter');
  await expect(page.locator('.settings-title')).toHaveText('Accounts & billing');
  await expect(page.locator('[data-account="codex:default"]')).toHaveClass(/acct-focus/);
  await expect(page.locator('[data-account="codex:second"]')).not.toHaveClass(/acct-focus/);
  // one heading per provider: no stray second MoPilot head before the usage limits
  await expect(page.locator('.provider-head', { hasText: 'MoPilot' })).toHaveCount(1);
});

test('accounts: two ChatGPT accounts are listed, and switching points Codex at the other', async ({ page, harness }) => {
  await openAccounts(page);
  await expect(row(page, 'first@example.test')).toBeVisible();
  await expect(row(page, 'second@example.test')).toBeVisible();
  await expect(row(page, 'first@example.test').getByText('In use', { exact: true })).toBeVisible();
  // grouped by provider, each heading naming only its provider; Pay with is folded under Advanced
  await expect(page.locator('.provider-name')).toHaveText(['MoPilot', 'Anthropic', 'OpenAI']);
  await expect(page.locator('.acct-add-row[data-harness="codex"]').getByRole('button')).toHaveText(['Add account', 'Use an API key']);
  await expect(page.locator('details.acct-advanced')).toHaveCount(2);
  await expect(page.getByText('Pay with', { exact: true }).first()).toBeHidden();
  await page.locator('details.acct-advanced summary').last().click();
  await expect(page.locator('details.acct-advanced').last().getByText('Pay with', { exact: true })).toBeVisible();
  // two ChatGPT accounts: one switch for moving on when one runs out
  await expect(page.getByText('Switch automatically when one runs out', { exact: true })).toBeVisible();

  // each row is its own Codex login, keyed by its account
  await expect(page.locator('.acct-row[data-account="codex:default"]')).toContainText('first@example.test');
  await expect(page.locator('.acct-row[data-account="codex:second"]')).toContainText('second@example.test');

  await row(page, 'second@example.test').getByRole('button', { name: 'Use' }).click();
  await expect(row(page, 'second@example.test').getByText('In use', { exact: true })).toBeVisible();
  await expect(row(page, 'first@example.test').getByText('In use', { exact: true })).toHaveCount(0);
  // the app-server was handed the second account's tokens
  await expect
    .poll(() =>
      harness
        .codexLog()
        .filter((l) => l.method === 'account/login/start' && l.params?.type === 'chatgptAuthTokens')
        .map((l) => l.params.chatgptAccountId),
    )
    .toContain('acct-second');
});

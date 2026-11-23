// Settings information architecture: one page per first-class harness with small sections, accounts
// only in Accounts & billing, and the Built-in tools group. Against both fakes.
import { standaloneNewChat } from './fixtures/sidebar';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { settingsLabel, settingsEntry } from './fixtures/settings';

test.use({ harnesses: 'both' });

async function openSettings(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  // Settings loads on first use (src/lib/lazyPage.tsx): its nav is read once it shows
  await expect(page.locator('.settings-nav .side-row').first()).toBeVisible();
}
const nav = (page: Page) => page.locator('.settings-nav .side-row:not(.muted)');

test('sidebar: grouped, no more than 21 items, accounts in one place', async ({ page }) => {
  await openSettings(page);
  const labels = await nav(page).locator('.side-row-label').allTextContents();
  expect(labels.length).toBeLessThanOrEqual(21);
  expect(labels.filter((l) => /account|billing|usage/i.test(l))).toEqual(['Accounts & billing']);
  expect(labels).toEqual(
    // Computer use is the macOS helper's: a Windows build has it off, its page too (shared/flagDefs.mjs NOT_ON_WINDOWS)
    expect.arrayContaining(
      ['codex', 'claude', 'harnesses', ...(process.platform === 'win32' ? [] : ['computer']), 'browser', 'voice', 'connections'].map(
        settingsLabel,
      ),
    ),
  );
  expect(labels).not.toContain(settingsLabel('other-harnesses'));
  expect(labels).not.toContain('Plugins');
});

test('harness pages: three sections, accounts only link to Accounts & billing', async ({ page }) => {
  await openSettings(page);
  await page.locator('.side-row', { hasText: 'Codex' }).first().click();
  const tabs = page.locator('.settings-tabs');
  await expect(tabs.locator('button')).toHaveText(['Overview', 'Extensions', 'Advanced']);
  // models, instructions and memory are on the Overview, with the way to accounts
  await expect(page.locator('.settings-group-title', { hasText: /^Memory and instructions$/ })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Accounts & billing' }).click();
  await expect(page.locator('.settings-title')).toHaveText('Accounts & billing');
  await expect(page.locator('.provider-head')).toContainText(['MoPilot', 'Anthropic', 'OpenAI']);

  // Advanced opens config.toml, and no longer offers the codex CLI's own approval and sandbox settings:
  // chats in MoPilot use the permission menu in the message box
  await page.locator('.side-row', { hasText: 'Codex' }).first().click();
  await tabs.getByText('Advanced').click();
  await expect(page.getByRole('button', { name: 'Open config.toml' })).toBeVisible();
  await expect(page.locator('.settings-row', { hasText: /Approval policy|Sandbox settings/ })).toHaveCount(0);

  await page.locator('.side-row', { hasText: 'Claude Code' }).click();
  await tabs.getByText('Extensions').click();
  await expect(page.locator('.settings-group-title', { hasText: /^MCP servers$/ })).toBeVisible();
});

test('All harnesses: one row per harness, and no test-machine results', async ({ page }) => {
  await openSettings(page);
  await page.locator('.settings-nav .side-row', { hasText: 'All agents' }).click();
  await expect(page.locator('[data-harness-row="codex"]')).toContainText('Codex');
  await expect(page.locator('[data-harness-row="claude"]')).toContainText('Claude Code');
  // no feature comparison: what a harness lacks is said on its own page
  await expect(page.getByTestId('compat-table')).toHaveCount(0);
  // the test machine's results are for support only, in Copy diagnostics (#1385)
  await expect(page.locator('summary', { hasText: 'Compatibility' })).toHaveCount(0);
  await expect(page.getByTestId('compat-basic')).toHaveCount(0);
  // a row opens its harness's page
  await page.locator('[data-harness-row="claude"]').click();
  await expect(page.locator('.harness-head-title')).toHaveText('Claude Code');
});

test.describe('cloud provider variables from the shell (D-35)', () => {
  test.use({ harnesses: 'claude', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } });

  const row = (page: Page) => page.locator('.settings-row', { hasText: 'Use cloud provider' });
  const chatEnvs = (h: Harness) =>
    h
      .claudeLog()
      .filter((e) => e.kind === 'argv' && e.argv.some((a) => /^--(session-id|resume)=/.test(a)))
      .map((e) => (e as any).cloudEnv as string[]);

  async function send(page: Page, text: string) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText(`fake-claude: ${text}`, { exact: true })).toBeVisible();
  }
  async function backToNewChat(page: Page) {
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await standaloneNewChat(page).click();
  }

  test('off by default the provider switches never reach Claude Code; on, they do and the badge shows the cloud route', async ({
    page,
    harness,
  }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await send(page, 'first');
    // names only, never values: the AWS settings pass through, the provider switch is held back
    expect(chatEnvs(harness).at(-1)).toEqual(['AWS_REGION']);

    await openSettings(page);
    await page.locator('.side-row', { hasText: 'Claude Code' }).first().click();
    // the switch is with how Claude Code runs, under Advanced
    await page.locator('.settings-tabs').getByText('Advanced', { exact: true }).click();
    await expect(row(page)).toContainText('Billed to your cloud account');
    await expect(row(page).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row(page).getByRole('switch').click();
    await expect(row(page).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    // the harness's row says who pays now
    await page.locator('.settings-nav .side-row', { hasText: 'All agents' }).click();
    await expect(page.locator('[data-harness-row="claude"]')).toContainText('API key · your cloud account');

    await backToNewChat(page);
    await send(page, 'second');
    expect(chatEnvs(harness).at(-1)).toEqual(['AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK']);

    // switching it off again holds the switch back from the next chat
    await openSettings(page);
    await page.locator('.side-row', { hasText: 'Claude Code' }).first().click();
    await page.locator('.settings-tabs').getByText('Advanced', { exact: true }).click();
    await row(page).getByRole('switch').click();
    await expect(row(page).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await backToNewChat(page);
    await send(page, 'third');
    expect(chatEnvs(harness).at(-1)).toEqual(['AWS_REGION']);
  });
});

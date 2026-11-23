// CUJ first-launch-harness-detect on both harnesses: after launch, Settings → All harnesses says what was detected for
// Codex and Claude Code (state, account and plan; models on each harness's page; the CLI's path and version in About),
// including a missing or signed-out harness. (Launch with each harness alone, the welcome flow and the fallback of the default are in cuj-codex,
// cuj-claude and welcome.)
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const ID = { Codex: 'codex', 'Claude Code': 'claude' } as const;
const card = (page: Page, name: keyof typeof ID) => page.locator(`[data-harness-row="${ID[name]}"]`);
// a row's state (src/harness/rowState.ts): quiet while ready, so the state is read from the row, not its words
const state = (page: Page, name: keyof typeof ID) => card(page, name);

// an About row's CLI version: the number with no "v", as every test here reads it
async function expectCliVersion(row: Locator, version: string) {
  await expect(row).toContainText(version);
  await expect(row).not.toContainText(`v${version}`);
}

async function openSettings(page: Page, item: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: item }).first().click();
}

test.describe('both installed and signed in', () => {
  test.use({ harnesses: 'both' });

  test('All harnesses shows both harnesses ready with plan and account, each page its models; About lists the CLI paths and versions', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await openSettings(page, 'All agents');
    await expect(state(page, 'Codex')).toHaveAttribute('data-row-state', 'ready');
    await expect(card(page, 'Codex')).toContainText('fake-user@example.test');
    await expect(state(page, 'Claude Code')).toHaveAttribute('data-row-state', 'ready');
    await expect(card(page, 'Claude Code')).toContainText('Claude Max');
    await expect(card(page, 'Claude Code')).toContainText('fake-user@example.test');
    // the default for new chats is a setting on this page
    await expect(page.locator('.settings-row', { hasText: 'New chats use' })).toContainText('Codex');

    // each harness's page lists its models
    await card(page, 'Codex').click();
    await expect(page.locator('.model-chips')).toContainText('Fake Model One');
    await page.locator('.side-row', { hasText: 'Claude Code' }).first().click();
    await expect(page.locator('.model-chips')).toContainText('Fake Sonnet');

    // About: where each CLI was found and its version
    await page.locator('.side-row', { hasText: 'About' }).click();
    // the version (no "v") and how it was installed; the full path on hover
    const codexRow = page.locator('.settings-row', { hasText: 'Codex CLI' });
    await expect(codexRow.locator('.cli-line')).toHaveAttribute('title', harness.env.CODEX_BIN);
    await expectCliVersion(codexRow, '0.162.0');
    const claudeRow = page.locator('.settings-row', { hasText: 'Claude Code CLI' });
    await expect(claudeRow.locator('.cli-line')).toHaveAttribute('title', harness.env.CLAUDE_BIN);
    await expectCliVersion(claudeRow, '999.0.0');
    // Manage goes to that harness's own page
    await claudeRow.getByRole('button', { name: 'Manage' }).click();
    await expect(page.locator('.settings-title')).toHaveText('Claude Code');
    // the app asked each CLI for its state at launch
    expect(harness.codexLog().map((e) => e.method)).toEqual(expect.arrayContaining(['account/read', 'model/list']));
    expect(harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth status --json')).toBe(true);
  });
});

test.describe('only Claude Code installed', () => {
  test.use({ harnesses: 'claude' });

  test('All harnesses offers Codex to install and shows Claude Code ready; About says Codex was not found', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await openSettings(page, 'All agents');
    // not installed: no row, and offered under Install another harness
    await expect(card(page, 'Codex')).toHaveCount(0);
    await expect(page.locator('.install-fold')).toContainText('Install another harness');
    await expect(state(page, 'Claude Code')).toHaveAttribute('data-row-state', 'ready');
    await page.locator('.side-row', { hasText: 'About' }).click();
    await expectCliVersion(page.locator('.settings-row', { hasText: 'Claude Code CLI' }), '999.0.0');
  });
});

test.describe('only Codex usable', () => {
  test.use({ harnesses: 'codex' });

  test('All harnesses marks the signed-out Claude Code, its page has a sign-in action; the picker offers Sign in', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await openSettings(page, 'All agents');
    await expect(state(page, 'Codex')).toHaveAttribute('data-row-state', 'ready');
    await expect(state(page, 'Claude Code')).toHaveAttribute('data-row-state', 'signin');
    await expect(card(page, 'Claude Code').getByRole('button', { name: 'Sign in to Claude Code' })).toBeVisible();
    await card(page, 'Claude Code').click();
    // the account card offers sign-in: "Sign in again" for a login it knows, "Sign in" when there is none
    await expect(page.getByRole('main').getByRole('button', { name: /^Sign in( again)?$/ })).toBeVisible();
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await openHarnessList(page);
    const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
    await expect(row).toContainText('Signed out');
    const signIn = row.getByRole('menuitem', { name: 'Sign in', exact: true });
    await expect(signIn).toBeVisible();
    await expect(signIn).toBeEnabled();
    // the row's choice is disabled, its Sign in is not: the row is not aria-disabled around it (#5117)
    await expect(row).toHaveAttribute('data-disabled', 'true');
  });
});

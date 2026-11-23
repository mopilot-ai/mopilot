// CUJ sign-in-auth on both harnesses: nothing is signed in, so the welcome page connects a row (ChatGPT for Codex, a
// terminal `claude auth login` for Claude Code), the first chat runs, then the user logs out in Settings and the welcome page signs in again. The fakes keep the login state: fake-codex through account/login/*, fake-claude through
// `auth login|logout` markers next to its log. The browser is never opened (shell.openExternal is replaced).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';
import { answerKeyCheck } from './fixtures/openaiKeyCheck';
import { connectWith, continueWelcome, welcomeHeading as heading } from './fixtures/welcome';
import { settingsEntry } from './fixtures/settings';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

async function openSettings(page: Page, item: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: item }).first().click();
}

test.describe('Codex', () => {
  test.use({ harnesses: 'codex', env: { FAKE_CODEX_AUTH: 'signed-out' } });

  test('sign-in-auth on Codex: the welcome page signs in with ChatGPT, a chat runs, sign out in Settings and sign in again', async ({
    page,
    harness,
  }) => {
    const opened = await captureExternal(harness);
    await expect(heading(page)).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    // Codex is installed but not signed in: its row connects with the ChatGPT login
    const codex = await connectWith(page, 'Codex', 'ChatGPT account');
    await codex.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
    await expect.poll(opened).toEqual(['https://auth.example.test/codex']);
    expect(harness.codexLog().find((e) => e.method === 'account/login/start')!.params).toMatchObject({ type: 'chatgpt' });
    // the login completes in the (fake) browser; the row says so by itself
    await expect(codex.getByText('Connected')).toBeVisible();
    // the first agent connected here moves the page on by itself
    await continueWelcome(page);
    await expect(composer(page)).toBeVisible();

    await composer(page).fill('signed in now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-codex: signed in now', { exact: true })).toBeVisible();

    // sign out in Settings: with nothing signed in the welcome page is back, and signs in again
    await openSettings(page, 'Accounts & billing');
    page.on('dialog', (d) => d.accept());
    // Sign out is in the account row's ⋯ menu
    await page
      .locator('.acct-row', { hasText: 'fake-user@example.test' })
      .getByRole('button', { name: /^More for / })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect.poll(() => harness.codexLog().some((e) => e.method === 'account/logout')).toBe(true);
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(heading(page)).toBeVisible();
    const again = await connectWith(page, 'Codex', 'ChatGPT account');
    await again.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
    await expect(again.getByText('Connected')).toBeVisible();
    expect(harness.codexLog().filter((e) => e.method === 'account/login/start')).toHaveLength(2);
    await continueWelcome(page);
    await expect(composer(page)).toBeVisible();
    // the chat from before is still there
    await expect(page.getByRole('complementary').getByText('Fake chat title', { exact: true })).toBeVisible();
  });

  test('sign-in-auth on Codex: an OpenAI API key signs in without a browser; a key OpenAI refuses says so', async ({ page, harness }) => {
    const opened = await captureExternal(harness);
    await expect(heading(page)).toBeVisible();
    const codex = await connectWith(page, 'Codex', 'API key');
    // the key is checked with OpenAI first (#1735), answered here: a refused key is not saved and says why
    let checked = await answerKeyCheck(harness, 401);
    await codex.getByLabel('API key').fill('sk-revoked-key');
    await codex.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText('OpenAI rejected that API key')).toBeVisible();
    await expect(codex.getByText('Connected')).toHaveCount(0);
    expect(harness.codexLog().some((e) => e.method === 'account/login/start')).toBe(false);
    checked = await answerKeyCheck(harness, 200);
    await codex.getByLabel('API key').fill('sk-test-key');
    await codex.getByRole('button', { name: 'Save key' }).click();
    await expect(codex.getByText('Connected')).toBeVisible();
    expect(await checked()).toEqual(['sk-revoked-key', 'sk-test-key']);
    await continueWelcome(page);
    await expect(composer(page)).toBeVisible();
    expect(harness.codexLog().find((e) => e.method === 'account/login/start')!.params).toMatchObject({ type: 'apiKey' });
    expect(await opened()).toEqual([]);
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'none' });

  test('sign-in-auth on Claude Code: the welcome page signs in in a terminal, a chat runs, sign out in Settings and sign in again', async ({
    page,
    harness,
  }) => {
    await expect(heading(page)).toBeVisible();
    const claude = await connectWith(page, 'Claude Code', 'Claude subscription');
    await claude.getByRole('button', { name: 'Sign in', exact: true }).click();
    // `claude auth login` runs in the embedded terminal, then the app checks again
    await expect(claude.getByText('Connected')).toBeVisible({ timeout: 30_000 });
    expect(harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
    await continueWelcome(page);
    await expect(composer(page)).toBeVisible();

    await composer(page).fill('signed in now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-claude: signed in now', { exact: true })).toBeVisible();

    // sign out: `claude auth logout` runs, the picker shows Signed out with Sign in and Re-check
    page.on('dialog', (d) => d.accept());
    await openSettings(page, 'Accounts & billing');
    // Sign out is in the account row's ⋯ menu
    await page
      .locator('.acct-row', { hasText: 'fake-user@example.test' })
      .getByRole('button', { name: /^More for / })
      .click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    // it runs at once, while Settings is still showing (no terminal tab to wait for)
    await expect
      .poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth logout'), { timeout: 30_000 })
      .toBe(true);
    // the app re-checks by itself, no Re-check needed
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    // nothing is signed in any more: the welcome page is back, and signs in again
    await expect(heading(page)).toBeVisible();
    const again = await connectWith(page, 'Claude Code', 'Claude subscription');
    await again.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(again.getByText('Connected')).toBeVisible({ timeout: 30_000 });
    expect(harness.claudeLog().filter((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toHaveLength(2);
    await continueWelcome(page);
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole('complementary').getByText('Fake chat title', { exact: true })).toBeVisible();
  });
});

// Adding a Claude login from a chat opens the terminal pane beside it (D-42); from Settings it is embedded
// in the page, which is not left (WP2-10). Against the fake Claude CLI.
import { test, expect } from './fixtures/app';

import fs from 'node:fs';
import path from 'node:path';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

test.use({
  harnesses: 'claude',
  seed: {
    files: (d) => {
      const second = { id: 'second', email: 'second@example.test', subscriptionType: 'max', authMethod: 'claude.ai', loggedIn: true };
      fs.writeFileSync(
        path.join(d.userData, 'claude-accounts.json'),
        JSON.stringify({ active: 'default', autoSwitch: true, accounts: [second] }),
      );
    },
  },
});

test("the signed-out banner in a chat re-signs the chat's own login and can switch to another (D-43)", async ({ page, harness }) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello there');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-claude: hello there', { exact: true })).toBeVisible();
  // put this chat on the second login
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).hover();
  await page.locator('.menu-item', { hasText: 'second@example.test' }).click();
  await page.keyboard.press('Escape');
  // the second login lapses; the login new chats use is still fine
  fs.mkdirSync(path.join(harness.dir, 'userData', 'claude-accounts', 'second'), { recursive: true });
  fs.writeFileSync(path.join(harness.dir, 'userData', 'claude-accounts', 'second', '.fake-signed-out'), '');
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Accounts & billing' }).first().click();
  await page.getByRole('button', { name: 'Re-check sign-in and usage' }).click();
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
  const banner = page.getByRole('alert').filter({ hasText: 'Your Claude Code sign-in' });
  await expect(banner).toBeVisible();
  // Sign in runs `claude auth login` as the chat's login, in a terminal beside the chat. The login is held open
  // while the terminal is checked: it closes when the login ends, which the fake would do at once.
  const letGo = harness.holdClaudeLogin();
  await banner.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.term-view')).toBeVisible();
  await expect.poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
  // it ran in the second login's folder, not the CLI's own
  const logins = harness.claudeLog().filter((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login') as any[];
  expect(logins.map((e) => path.basename(e.configDir ?? ''))).toEqual(['second']);
  letGo();
  await expect(page.locator('.term-view')).toHaveCount(0, { timeout: 30000 });
  // Use another account moves the chat to the login that is still signed in, and the banner goes
  await banner.getByRole('button', { name: 'Use another account' }).click();
  await expect(banner).toBeHidden();
});

test('Add Claude account in Settings embeds the login terminal and re-checks when it exits (WP2-10)', async ({ page, harness }) => {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Accounts & billing' }).first().click();
  const letGo = harness.holdClaudeLogin();
  await page.locator('.acct-add-row[data-harness="claude"]').getByRole('button', { name: 'Add account' }).click();
  // the terminal is on the Settings page itself; Settings is not left
  await expect(page.locator('.basic-login-term .term-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeHidden();
  await expect.poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
  // the login ends; the embedded terminal closes
  letGo();
  await expect(page.locator('.basic-login-term')).toBeHidden({ timeout: 30000 });
});

test.describe('with Codex also usable', () => {
  test.use({ harnesses: 'both' });

  test("the picker's Sign in inside a chat signs in that chat's own login, not the one new chats use (D-43)", async ({ page, harness }) => {
    // the chat starts on Claude Code
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello there');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-claude: hello there', { exact: true })).toBeVisible();
    // put this chat on the second login
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).hover();
    await page.locator('.menu-item', { hasText: 'second@example.test' }).click();
    await page.keyboard.press('Escape');
    // the login new chats use lapses
    fs.writeFileSync(path.join(harness.dir, 'home', '.claude', '.fake-signed-out'), '');
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await page.locator('.side-row', { hasText: 'Accounts & billing' }).first().click();
    await page.getByRole('button', { name: 'Re-check sign-in and usage' }).click();
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
    await openHarnessList(page);
    const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
    const signIn = row.getByRole('menuitem', { name: 'Sign in', exact: true });
    await expect(signIn).toBeEnabled();
    await signIn.click();
    await expect.poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
    const logins = harness.claudeLog().filter((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login') as any[];
    expect(logins.map((e) => path.basename(e.configDir ?? ''))).toEqual(['second']);
  });
});

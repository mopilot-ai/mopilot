// Harness detection through the login shell's environment: the fake Claude CLI is only on the PATH
// that the user's (fake) login shell exports, as with nvm or ~/.local/bin on a Dock launch.
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, FAKE_CLAUDE } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });

test.use({ harnesses: 'claude', claudeOnShellPath: true });

test('env-snapshot: a Claude CLI on the login shell PATH is detected and runs; a custom path overrides it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect your coding agents' })).toHaveCount(0);
  await openHarnessList(page);
  // the row is usable (signed in); the signed-in account is named in its flyout, next to the models (#309)
  const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
  await expect(row).toBeEnabled();
  await expect(row).not.toContainText('Signed out');
  await row.hover();
  await expect(page.locator('.acct-email', { hasText: 'fake-user@example.test' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth status --json')).toBe(true);

  // Settings → Claude Code names the binary found on the shell PATH, and a custom path replaces it
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Claude Code' }).click();
  // the CLI in use is one Version row under Advanced; the full path is on hover, another one is chosen from its menu
  await page.locator('.settings-tabs').getByText('Advanced', { exact: true }).click();
  const version = page.locator('.settings-row', { has: page.getByText('Version', { exact: true }) });
  const cli = version.locator('.cli-line');
  // the launcher program on Windows (fixtures/nodeCommand.ts)
  await expect(cli).toHaveAttribute('title', path.join(harness.dir, 'shell-bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  await version.getByRole('button', { name: 'Claude Code CLI options' }).click();
  await page.getByRole('menuitem', { name: 'Choose another…' }).click();
  const custom = page.getByRole('textbox', { name: 'claude binary path' });
  await custom.fill(FAKE_CLAUDE);
  await custom.press('Enter');
  await expect(cli).toHaveAttribute('title', FAKE_CLAUDE);
  await expect(cli).toContainText('Custom location');
});

test('Settings → About copies diagnostics with the environment redacted', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'About' }).click();
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.getByText('Diagnostics copied')).toBeVisible();
  const text = await harness.app.evaluate(({ clipboard }) => clipboard.readText());
  // Windows reads no login shell: the app's own environment is the user's there (electron/platform/env.cjs)
  expect(text).toContain(`Login shell environment: ${process.platform === 'win32' ? 'not captured' : 'captured'}`);
  expect(text).toContain('Environment');
  // the test machine's harness results, for support only, in plain words (#1385)
  expect(text).toContain("Harness checks (MoPilot's test machine; these versions, not this Mac)");
  expect(text).toContain('Basic harnesses on the test machine');
  expect(text).not.toMatch(/CM-[A-Z]\d|session\/new/);
  // paths name the user as <user>, never by name
  expect(text).not.toContain(`/Users/${os.userInfo().username}`);
});

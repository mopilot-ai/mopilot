// The welcome page with nothing usable (WP3-11): every agent in one ranked list, each connected in its row, then
// Continue. Against the fake Claude CLI, signed out, and no Codex.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { savedDefaultHarness } from './fixtures/defaultHarness';
import { agentRow, connectWith, continueWelcome, welcomeHeading } from './fixtures/welcome';
import { ACP_PUBLIC_IDS } from '../../shared/harnessCatalog.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

test.use({ harnesses: 'none' });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const missingAgents = new RegExp(`^${ACP_PUBLIC_IDS.length} more: Copilot, Cursor, Gemini, `);

test('every agent is listed: Claude Code to connect, Codex to install, the others folded; no chat yet', async ({ page }) => {
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(agentRow(page, 'Claude Code').getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect(agentRow(page, 'Codex').getByRole('button', { name: 'Install' })).toBeVisible();
  await expect(page.getByRole('button', { name: missingAgents })).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  // nothing connected: Continue asks for one and stays
  await continueWelcome(page);
  await expect(page.getByText('Connect an agent to continue.')).toBeVisible();
  await expect(welcomeHeading(page)).toBeVisible();
});

test('Codex missing: its row offers the recommended install, the other ways folded, and nothing runs until Install', async ({ page }) => {
  const codex = agentRow(page, 'Codex');
  await codex.getByRole('button', { name: 'Install', exact: true }).click();
  // the shared install table's recommended line (shared/harnessInstall.mjs, #1289): the vendor's script, no Node.js needed
  await expect(page.getByLabel('Install command for Codex with Script')).toHaveText('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  const install = page.getByRole('button', { name: 'Run curl -fsSL https://chatgpt.com/codex/install.sh | sh' });
  await expect(install).toHaveText('Install');
  await expect(page.getByLabel('Install command for Codex with npm')).toHaveCount(0);
  await codex.getByRole('button', { name: 'Other ways to install' }).click();
  await expect(page.getByLabel('Install command for Codex with npm')).toHaveText('npm install -g @openai/codex');
  await expect(codex.getByRole('button', { name: "I'll do it myself" })).toBeVisible();
  await expect(page.locator('.term-view')).toHaveCount(0);
});

test('Antigravity without a one-line installer offers setup instructions, vendor docs and a location', async ({ page }) => {
  await page.getByRole('button', { name: missingAgents }).click();
  const antigravity = agentRow(page, 'Antigravity');
  await antigravity.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(antigravity.getByText(/localharness_external/)).toBeVisible();
  await expect(antigravity.getByRole('button', { name: 'Get it from Google ↗', exact: true })).toBeVisible();
  await expect(antigravity.getByRole('button', { name: 'Set location…', exact: true })).toBeVisible();
  await expect(antigravity.getByRole('button', { name: /^Run / })).toHaveCount(0);
  await expect(page.locator('.term-view')).toHaveCount(0);
});

test('MoPilot credits on Claude Code ask for the MoPilot sign-in, not a claude.ai login', async ({ page }) => {
  const claude = await connectWith(page, 'Claude Code', 'MoPilot credits');
  await expect(claude.getByRole('button', { name: 'Sign in to MoPilot' })).toBeVisible();
  await expect(claude.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
});

test('API key: save it, the row connects, Continue starts the first chat on it', async ({ page, harness }) => {
  const claude = await connectWith(page, 'Claude Code', 'API key');
  await claude.getByLabel('API key').fill('sk-ant-test-key');
  await claude.getByRole('button', { name: 'Save key' }).click();
  await expect(claude.getByText('Connected')).toBeVisible();
  // the first agent connected on a page opened with none moves it on by itself
  await expect(composer(page)).toBeVisible();
  await expect(welcomeHeading(page)).toHaveCount(0);
  await expect(() => expect(savedDefaultHarness(harness)).toBe('claude')).toPass({ timeout: 10_000 });
});

test.describe('Claude Code only (A1, A2 gate)', () => {
  test.use({ harnesses: 'claude' });

  test('the app opens on Home: no welcome, no Codex error, no basic-only hint', async ({ page }) => {
    await expect(composer(page)).toBeVisible();
    await expect(welcomeHeading(page)).toHaveCount(0);
    await expect(page.getByText("Couldn't connect to Codex")).toHaveCount(0);
    await expect(page.getByText('Only a basic harness is set up.')).toHaveCount(0);
  });
});

test.describe('only a basic harness (A2 gate)', () => {
  test.use({ harnesses: 'none', acp: { kimi: {} } });

  test('Home opens and offers Codex or Claude Code; the welcome page lists the basic harness first, connected', async ({ page }) => {
    await expect(composer(page)).toBeVisible();
    await expect(welcomeHeading(page)).toHaveCount(0);
    await page.getByText('Set up Codex or Claude Code').click();
    await expect(welcomeHeading(page)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Coding agents' }).getByRole('listitem').first()).toContainText('Kimi Code');
    await expect(agentRow(page, 'Kimi Code').getByText('Connected')).toBeVisible();
    // Claude Code connects from its own row, one click away
    await expect(agentRow(page, 'Claude Code').getByRole('button', { name: 'Connect' })).toBeVisible();
  });

  test('Continue leaves the welcome page and new chats start on the basic harness', async ({ page }) => {
    await page.getByText('Set up Codex or Claude Code').click();
    await expect(page.getByText('New chats start with Kimi Code.')).toBeVisible();
    await continueWelcome(page);
    await expect(welcomeHeading(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');
  });
});

test.describe('a basic harness installed but signed out (A2 gate)', () => {
  // not Copilot: it refuses stdio MCP servers, so it reads unsupported before any sign-in
  test.use({
    harnesses: 'none',
    acp: { gemini: { needsAuth: true, terminalLogin: true } },
  });

  test('the welcome page lists it to sign in, and signs it in in an embedded terminal', async ({ page, harness }) => {
    await expect(welcomeHeading(page)).toBeVisible();
    const gemini = agentRow(page, 'Gemini');
    await expect(gemini.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // nothing connected to carry on with until it is signed in
    await expect(page.getByText(/New chats start with/)).toHaveCount(0);
    // The fake can sign in and exit before Playwright observes the transient terminal.
    const release = harness.holdAcpLogin('gemini');
    try {
      await gemini.getByRole('button', { name: 'Sign in' }).click();
      await gemini.getByRole('button', { name: 'Log in in terminal' }).click();
      await expect(gemini.locator('.term-view')).toBeVisible();
      release();
      // The login exits and the harness is checked again: it is admitted, so it connects, and the first agent
      // connected here moves the page on to a new chat.
      await expect(gemini.getByText('Connected')).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    } finally {
      release();
    }
  });
});

test.describe('nothing installed (A26 gate)', () => {
  test('the welcome page lists no basic harness above the fold and no way past it without connecting one', async ({ page }) => {
    await expect(welcomeHeading(page)).toBeVisible();
    await expect(agentRow(page, 'Kimi Code')).toHaveCount(0);
    await continueWelcome(page);
    await expect(page.getByText('Connect an agent to continue.')).toBeVisible();
  });
});

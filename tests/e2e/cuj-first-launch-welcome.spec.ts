// CUJ first-launch-welcome: a new install is welcomed once even when a basic agent already works, each way to pay is
// explained, a failed check is said under its row, and after Continue and a relaunch the page stays away; Settings then
// reads a never-signed-in Claude Code as Not signed in and the signed-in basic harness offers Sign in again. An older
// install whose default can't run says why on Home. (The welcome page with nothing usable: welcome.spec.)
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { savedDefaultHarness } from './fixtures/defaultHarness';
import { openSettingsSection, settingsEntry } from './fixtures/settings';
import { agentRow, continueWelcome, welcomeHeading } from './fixtures/welcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
/** Kimi Code, signed in through its one ACP sign-in. */
const KIMI = { kimi: { authMethods: [{ id: 'kimi-login', name: 'Login with Kimi', description: 'Sign in to Kimi' }] } };
const prefs = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'ui-state.json'), 'utf8')).prefs;

async function openSettings(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
}

test.describe('a new install with only a basic agent working', () => {
  // no Codex, Claude Code installed but never signed in; welcomeDone false is how main settles a new install
  test.use({ harnesses: 'none', acp: KIMI, seed: { uiState: { prefs: { welcomeDone: false } } } });

  test('welcomed once: each way to pay explained, failures under the row, Continue, then not again after a relaunch', async ({
    page,
    harness,
  }) => {
    // 1. the page opens although Kimi Code can run a chat: Codex and Claude Code are offered first
    await expect(welcomeHeading(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toHaveCount(0);
    await expect(agentRow(page, 'Kimi Code').getByText('Connected')).toBeVisible();
    const claude = agentRow(page, 'Claude Code');
    const codex = agentRow(page, 'Codex');
    // each row's one action is a button (a pill), not words that read as its state
    await expect(claude.getByRole('button', { name: 'Connect', exact: true })).toHaveClass(/btn-pill/);
    await expect(codex.getByRole('button', { name: 'Install', exact: true })).toHaveClass(/btn-pill/);
    // the fold names the agents it hides, the featured ones first
    const more = page.getByRole('button', { name: /^\d+ more: Copilot, Cursor, Gemini, / });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('title', /^Copilot, Cursor, Gemini, /);
    await more.click();
    await expect(agentRow(page, 'Copilot').getByRole('button', { name: 'Install', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show fewer' }).click();
    await expect(agentRow(page, 'Copilot')).toHaveCount(0);

    // 2. Claude Code's ways to pay: the subscription is offered alone, the others behind a link, and each says who is paid
    await claude.getByRole('button', { name: 'Connect', exact: true }).click();
    const ways = claude.getByRole('group', { name: 'Connect Claude Code with' });
    await expect(ways).toHaveCount(0);
    await expect(claude.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await claude.getByRole('button', { name: 'Use an API key or credits' }).click();
    await expect(ways.getByRole('button', { name: 'Claude subscription' })).toHaveAttribute('aria-pressed', 'true');
    await expect(claude.getByText('Use your Claude Pro, Max, Team or Enterprise plan.')).toBeVisible();
    await ways.getByRole('button', { name: 'API key' }).click();
    await expect(ways.getByRole('button', { name: 'API key' })).toHaveAttribute('aria-pressed', 'true');
    await expect(claude.getByText('Pay Anthropic per use with your own key.')).toBeVisible();
    await expect(claude.getByLabel('API key')).toBeVisible();
    await ways.getByRole('button', { name: 'MoPilot credits' }).click();
    await expect(claude.getByText('Pay as you go with credits from your MoPilot account.')).toBeVisible();
    await expect(claude.getByRole('button', { name: 'Sign in to MoPilot' })).toBeVisible();
    await ways.getByRole('button', { name: 'Claude subscription' }).click();

    // 3. Re-check (offered once the sign-in has had a while) while still signed out: Claude Code's own words, under
    // its row, not a toast that goes
    await claude.getByRole('button', { name: 'Re-check' }).click({ timeout: 30_000 });
    await expect(claude.getByRole('alert')).toHaveText('Claude Code is still signed out. Finish `claude auth login`, then re-check.');
    await expect(claude.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    // choosing another way to pay clears it
    await ways.getByRole('button', { name: 'API key' }).click();
    await expect(claude.getByRole('alert')).toHaveCount(0);

    // Codex's Install: the recommended command, looked for in the background, and a re-check (offered after a while)
    // that still finds nothing says so under the row
    await codex.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(codex.getByLabel('Install command for Codex with Script')).toBeVisible();
    await codex.getByRole('button', { name: 'Re-check' }).click({ timeout: 30_000 });
    await expect(codex.locator('.welcome-row-error, .welcome-row-said')).toHaveText(/\S/);
    await expect(codex.getByRole('button', { name: 'Install', exact: true })).toBeVisible();

    // 4. Continue: new chats start on the connected agent, and the page is done for good
    await expect(page.getByText('New chats start with Kimi Code. You can change it anytime.')).toBeVisible();
    await continueWelcome(page);
    await expect(welcomeHeading(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');
    await expect.poll(() => prefs(harness).welcomeDone).toBe(true);
    await expect.poll(() => savedDefaultHarness(harness)).toBe('acp:kimi');

    // 5. relaunch: Home, not the welcome page; it is still one link away
    await harness.relaunch();
    const again = harness.page;
    await expect(composer(again)).toBeVisible({ timeout: 30_000 });
    await expect(welcomeHeading(again)).toHaveCount(0);
    await expect(again.getByText('Only a basic harness is set up.')).toBeVisible();
    await expect(again.getByRole('button', { name: 'Set up Codex or Claude Code' })).toBeVisible();

    // 6. Settings: the basic harness that signed in offers Sign in again (its method named on hover), not its first label
    await openSettings(again);
    await openSettingsSection(again, 'other-harnesses');
    const kimi = again.locator('.basic-row[data-harness="kimi"]');
    await expect(kimi.locator('.basic-row-state')).toHaveText('Ready', { timeout: 20_000 });
    await kimi.getByRole('button', { name: 'Show Kimi Code details' }).click();
    const signInAgain = kimi.getByRole('button', { name: 'Sign in again', exact: true });
    await expect(signInAgain).toBeVisible();
    await expect(signInAgain).toHaveAttribute('title', 'Login with Kimi');
    await expect(kimi.getByRole('button', { name: 'Login with Kimi' })).toHaveCount(0);

    // Accounts & billing: a Claude Code nobody signed in to is no account, "Not signed in" with Sign in, as Codex reads
    await again.locator('.side-row', { hasText: 'Accounts & billing' }).first().click();
    const row = again.locator('.settings-row', { hasText: 'Claude Code: Not signed in' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(again.getByRole('main').getByText('In use', { exact: true })).toHaveCount(0);
    await expect(again.getByRole('main').getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
  });
});

test.describe('an existing install whose default never signed in', () => {
  // set up before the welcome page kept its mark: Claude Code is the default, but never signed in; Kimi Code works
  test.use({ harnesses: 'none', acp: KIMI, seed: { uiState: { prefs: { defaultHarness: 'claude' } } } });

  test('no welcome; Home and All harnesses say Claude Code isn’t signed in and where new chats start instead', async ({ page }) => {
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
    await expect(welcomeHeading(page)).toHaveCount(0);
    const note = 'Claude Code isn’t signed in; new chats start in Kimi Code';
    const chip = page.locator('[data-default-fallback]');
    await expect(chip).toContainText(note, { timeout: 20_000 });
    // never "signed out" for a login that never was
    await expect(chip).not.toContainText('signed out');
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');
    await expect(page.getByRole('button', { name: 'Set up Codex or Claude Code' })).toBeVisible();

    // its button opens All harnesses, which says the same and offers Claude Code's sign-in
    await chip.getByRole('button', { name: 'Harness settings' }).click();
    await expect(page.locator('.settings-row', { hasText: 'New chats use' })).toContainText(note);
    const claude = page.locator('[data-harness-row="claude"]');
    await expect(claude).toHaveAttribute('data-row-state', 'signin');
    await expect(claude.getByRole('button', { name: 'Sign in to Claude Code' })).toBeVisible();
    // the saved choice stays the user's: the fallback is for this run only
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(chip).toContainText(note);
  });
});

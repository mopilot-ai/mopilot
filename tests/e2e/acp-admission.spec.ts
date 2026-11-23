// Runtime admission for basic-tier harnesses, in the real app: only harnesses that pass it are in the
// picker; Settings → Other harnesses says why the others aren't, and a terminal login re-checks.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openSettingsSection, settingsEntry } from './fixtures/settings';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
async function openOtherHarnesses(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await openSettingsSection(page, 'other-harnesses');
}
const status = (page: Page, id: string) => page.locator(`[data-harness-status="${id}"]`);
/** An installed harness's state on its row: Ready once it passed admission. */
const state = (page: Page, id: string) => page.locator(`.basic-row[data-harness="${id}"] .basic-row-state`);
/** Harnesses not installed past the first few fold behind Show all. */
async function showAllAvailable(page: Page) {
  const more = page.getByRole('button', { name: 'Show all', exact: true });
  if (await more.isVisible()) await more.click();
}
/** A harness not installed: listed to install, with where to set its location. */
const available = (page: Page, id: string) =>
  page.locator('.settings-group', { hasText: 'Available to install' }).locator(`.basic-row[data-harness="${id}"]`);

test.describe('Antigravity tool connection failure', () => {
  test.use({ harnesses: 'codex', acp: { antigravity: { noMcp: true } } });

  test('the installed agent retains its tool failure and retry without prescribing an update', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(home(page)).toBeVisible();
    await openOtherHarnesses(page);
    const reason = "Installed · Can't run in MoPilot · MoPilot can't give Antigravity computer and browser control";
    await expect(status(page, 'antigravity')).toHaveText(reason, { timeout: 20_000 });
    await expect(state(page, 'antigravity')).toHaveText("Can't run");
    const row = page.locator('.basic-row[data-harness="antigravity"]');
    await expect(row).not.toContainText('Needs an update');
    await row.getByRole('button', { name: 'Show Antigravity details' }).click();
    await row.getByRole('button', { name: 'Re-check', exact: true }).click();
    await expect(status(page, 'antigravity')).toHaveText(reason, { timeout: 20_000 });
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await openHarnessList(page);
    await expect(page.locator('.hp-harnesses .hp-row').filter({ hasText: 'Antigravity' })).toHaveCount(0);
  });
});

test.describe('admission', () => {
  test.use({
    harnesses: 'codex',
    acp: {
      kimi: {},
      // ignores the MCP servers it is given, so sage-mcp never says hello
      qwen: { noMcp: true },
      // wants a login first, done in a terminal (not Copilot: it refuses stdio MCP servers, so it reads
      // unsupported before any sign-in while MoPilot offers its tools over stdio)
      gemini: { needsAuth: true, terminalLogin: true },
    },
  });

  test('Other harnesses shows each state; the picker lists only admitted ones; a terminal login re-checks', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await openOtherHarnesses(page);
    await expect(page.getByRole('heading', { name: 'Other agents' })).toBeVisible();

    await expect(state(page, 'kimi')).toHaveText('Ready', { timeout: 20_000 });
    await expect(status(page, 'qwen')).toHaveText(
      "Installed · Can't run in MoPilot · MoPilot can't give Qwen Code computer and browser control",
      { timeout: 20_000 },
    );
    await expect(status(page, 'gemini')).toHaveText('Sign in to Gemini first', { timeout: 20_000 });
    await showAllAvailable(page);
    await expect(available(page, 'goose')).toBeVisible();

    // the picker offers Kimi only, with the Basic badge
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    const rows = page.locator('.hp-harnesses .hp-row');
    await expect(rows.filter({ hasText: 'Kimi Code' })).toContainText('Limited');
    await expect(rows.filter({ hasText: 'Qwen Code' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Gemini' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // sign in to Gemini in the embedded terminal; when it exits the harness is checked again
    await openOtherHarnesses(page);
    await expect(page.getByRole('heading', { name: 'Other agents' })).toBeVisible();
    await page.getByRole('button', { name: 'Log in in terminal' }).click();
    await expect(state(page, 'gemini')).toHaveText('Ready', { timeout: 20_000 });
  });

  test('the Basic badge\'s "See what\'s different" opens Other harnesses', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await openOtherHarnesses(page);
    await expect(state(page, 'kimi')).toHaveText('Ready', { timeout: 20_000 });
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row .hp-badge.basic').first().hover();
    await page.getByRole('button', { name: "See what's different", exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Other agents' })).toBeVisible();
    await expect(state(page, 'kimi')).toHaveText('Ready');
  });
});

test.describe('a binary path typed in Settings', () => {
  test.use({ harnesses: 'codex', acp: { kimi: {} } });

  test('Goose is not on PATH; giving its path finds it and it is admitted', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await openOtherHarnesses(page);
    await expect(state(page, 'kimi')).toHaveText('Ready', { timeout: 20_000 });
    await showAllAvailable(page);
    // not installed: its location is set behind Set location… and Change…
    await available(page, 'goose').getByRole('button', { name: 'Set location…' }).click();
    await available(page, 'goose').getByRole('button', { name: 'Change…' }).click();
    const box = page.getByRole('textbox', { name: 'goose binary path' });
    await box.fill(`${harness.dir}/acp-bin/kimi`);
    await box.press('Enter');
    await expect(state(page, 'goose')).toHaveText('Ready', { timeout: 20_000 });
  });
});

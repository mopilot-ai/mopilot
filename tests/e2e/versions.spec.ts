// The versions policy in the real app (WP5-20, A24) against fake-codex.mjs: a newer, untested Codex
// works as usual and greys out only the capability whose probe failed; a Codex below the minimum
// version says it doesn't work with this MoPilot, and only the Codex entry is affected.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

test.describe('a newer Codex without collaborationMode/list', () => {
  test.use({ env: { FAKE_CODEX_VERSION: '0.170.0', FAKE_CODEX_MISSING: 'collaborationMode/list' } });

  test('versions: chats work as usual; only Plan is greyed out, with why', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await composer(page).fill('hello there');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-codex: hello there', { exact: true })).toBeVisible();
    // no "needs verification" anywhere
    await expect(page.getByText(/verif/i)).toHaveCount(0);

    await composer(page).fill('/plan');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Codex 0.170.0 changed how plan mode works · Update MoPilot')).toBeVisible();
    await expect(page.locator('.plan-chip')).toHaveCount(0);
  });
});

test.describe('a Codex below the minimum version', () => {
  test.use({ harnesses: 'both', env: { FAKE_CODEX_VERSION: '0.150.0' } });

  test('versions: Codex says it is incompatible; Claude Code carries on', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    // new chats fall back to Claude Code for this run
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake');
    await openHarnessList(page);
    const row = page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' });
    await expect(row).toContainText("Codex 0.150.0 doesn't work with this version of MoPilot");
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await composer(page).fill('still here');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-claude: still here', { exact: true })).toBeVisible();
  });
});

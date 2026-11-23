// #4908 on This Mac: Claude Code's login is one the provider refuses for its organization (the fake CLI's `ORGBLOCKED` turn: HTTP 403 oauth_not_allowed_for_organization). The chat says it once, in a few words, with the way on (Sign in) and no Retry, and does not draw the CLI's sentence again as a reply.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';

// Codex stays signed in: with Claude Code the only harness, its refused login leaves nothing that can run a chat and the app goes back to its first-run page (as for a lapsed login, cuj-errors-limits-offline), taking the chat with it.
test.use({ harnesses: 'both', seed: { uiState: SYSTEM_THEME } });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test('a refused login reads once with Sign in, no Retry and no second copy of the sentence', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await page.keyboard.press('Escape');
  await composer(page).fill('ORGBLOCKED keep going');
  await expect(composer(page)).toHaveText('ORGBLOCKED keep going');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('main').locator('.turn-error');
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card).toContainText("Claude Code can't run: its login is refused");
  await expect(card).toContainText('Sign in again.');
  await expect(card).not.toContainText('another machine');
  await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.locator('.assistant-message').filter({ hasText: 'disabled Claude subscription access' })).toHaveCount(0);
  await shootBoth(page, harness.app, 'refused-local-error-card');
  // Sign in starts the CLI's own sign-in, as it does for a lapsed login
  await card.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth login')).toBe(true);
});

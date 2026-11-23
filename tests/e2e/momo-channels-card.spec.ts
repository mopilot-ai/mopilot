// A card raised by a turn in a MoMo channel stays in that channel (A2, `momo.channels`), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1): the momoAction card a channel's turn raises waits in the channel's chat, Main shows nothing of it while it waits, Tasks lists it naming its channel and Review opens that channel on it (#4846), Allow once settles it in the channel (its result is the channel's), Main shows nothing of the card or its result afterwards, and Everything lists the result under the channel's name. Its own spec because the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS (momo-channels.spec.ts runs on Linux too).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChat, momoChatSession, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { shell: true, channels: true, tasksPanel: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

const rail = (page: Page) => page.locator('[data-momo-shell]').getByRole('navigation', { name: 'MoMo' });

test('a card raised in a channel settles in that channel; Main shows nothing of it', async ({ page }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  const session = await momoChatSession(page);
  const card = momoChat(page).locator('[data-kind="momoAction"]');
  const result = momoChat(page).getByText(/Saved\. Wrote: one/);

  // a channel, made by name
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  await page.locator('.dialog').getByRole('textbox', { name: 'Name' }).fill('Trip');
  await page.locator('.dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Trip', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });

  // the turn in the channel raises the card, which waits there
  await session.send('CUCALL momo_debug_action {"text":"one"}');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('heading')).toHaveText('Allow MoMo to change Test notes?');

  // Main has no card while it waits
  await rail(page).getByRole('button', { name: 'Main', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(card).toHaveCount(0);

  // Tasks lists the waiting card naming its channel, and Review opens that channel on the card, not Main
  await goToMomoView(page, 'Tasks');
  const task = page.locator('[data-task^="card:"]');
  await expect(task).toHaveCount(1, { timeout: 30_000 });
  await expect(task).toContainText('#Trip');
  await task.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Trip', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // answered in the channel: the result is the channel's
  await rail(page).getByRole('button', { name: 'Trip', exact: true }).click();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(result).toBeVisible({ timeout: 30_000 });

  // Main shows nothing of the card or what it did
  await rail(page).getByRole('button', { name: 'Main', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(card).toHaveCount(0);
  await expect(result).toHaveCount(0);
  await expect(momoChat(page).getByText(/Allow MoMo to change Test notes/)).toHaveCount(0);

  // Everything lists the result under the channel's name, never under Main's
  await rail(page).getByRole('button', { name: 'Everything', exact: true }).click();
  const feed = page.getByRole('region', { name: 'Everything', exact: true });
  await expect(feed.locator('[data-channel]').filter({ hasText: '#Trip' }).filter({ hasText: 'Saved. Wrote: one' }).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(feed.locator('[data-channel="main"]').filter({ hasText: 'Saved. Wrote: one' })).toHaveCount(0);
});

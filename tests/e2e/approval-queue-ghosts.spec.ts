// Two approvals queued in one chat: the first card shows with one ghost peeking above it and "1 more waiting";
// answering it leaves the second card alone, with no ghost.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const card = (page: Page) => page.locator('.approval-card');

test.use({ harnesses: 'both' });

test('queued approvals: one ghost peeks above the shown card, none for the last one', async ({ page }) => {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await composer(page).fill('ASKPAIR go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(card(page)).toHaveCount(1);
  await expect(page.locator('.approval-queue')).toContainText('1 more waiting');
  await expect(page.locator('.approval-ghost')).toHaveCount(1);
  // the card's own promote animation moves it 6px while it plays: measure once it has settled
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const shown = (await card(page).boundingBox())!;
  const ghost = (await page.locator('.approval-ghost').boundingBox())!;
  expect(shown.y - ghost.y).toBeGreaterThanOrEqual(5);
  expect(ghost.width).toBeLessThan(shown.width);

  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(card(page)).toHaveCount(1);
  await expect(page.locator('.approval-ghost')).toHaveCount(0);
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(page.getByRole('main').getByText(/fake-claude: ASKPAIR go \[pair: allow,allow\]/)).toBeVisible();
});

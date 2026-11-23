// MoMo's first run offers the Morning brief (A7), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1): the second screen ("Stay in the loop") has a Morning brief row beside Notifications, off until Turn on, which is saved and shows in Settings › MoMo › Proactivity; Continue without it leaves the brief off there. Neither run asks for Calendar or Reminders.
import { test, expect } from './fixtures/app';
import { goToMomoSettings, meetHeading, momoChat, notificationsHeading, openMomo } from './fixtures/momo';

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });

const briefRow = (page: import('@playwright/test').Page) => page.locator('.momo-connect-row').filter({ hasText: 'Morning brief' });

async function toNotifications(page: import('@playwright/test').Page) {
  await openMomo(page, { setup: 'stay' });
  await expect(meetHeading(page)).toBeVisible();
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(next).toBeEnabled({ timeout: 15_000 });
  await next.click();
  await expect(notificationsHeading(page)).toBeVisible();
}

async function briefSwitch(page: import('@playwright/test').Page) {
  await goToMomoSettings(page, 'Brain');
  const row = page.locator('.settings-row').filter({ hasText: 'Morning brief' });
  await row.scrollIntoViewIfNeeded();
  return row.getByRole('switch');
}

test('Turn on in the first run is saved and shows on in Settings', async ({ page }) => {
  await toNotifications(page);
  await expect(briefRow(page)).toContainText('A short note when quiet hours end.');
  await expect(page.getByText('Calendar', { exact: true })).toHaveCount(0);
  await briefRow(page).getByRole('button', { name: 'Turn on' }).click();
  await expect(briefRow(page)).toContainText('On');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(momoChat(page)).toBeVisible({ timeout: 20_000 });
  await expect(await briefSwitch(page)).toHaveAttribute('aria-checked', 'true');
});

test('Continue without it leaves the brief off', async ({ page }) => {
  await toNotifications(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(momoChat(page)).toBeVisible({ timeout: 20_000 });
  await expect(await briefSwitch(page)).toHaveAttribute('aria-checked', 'false');
});

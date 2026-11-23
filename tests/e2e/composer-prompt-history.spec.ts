// ↑ in an empty composer recalls the chat's earlier prompts with a "History n/N" line, and still does after the
// window reloads, on every harness: the history is read from the chat's transcript, not kept by one composer.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const label = (page: Page) => page.locator('.composer-history');

async function send(page: Page, harness: string, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(page.getByRole('main').getByText(`fake-${harness}: ${text}`, { exact: true })).toBeVisible();
}

async function stepsBack(page: Page) {
  await composer(page).press('ArrowUp');
  await expect(composer(page)).toHaveText('second prompt');
  await expect(label(page)).toHaveText('History 2/2');
  await composer(page).press('ArrowUp');
  await expect(composer(page)).toHaveText('first prompt');
  await expect(label(page)).toHaveText('History 1/2');
}

for (const harness of ['codex', 'claude'] as const) {
  test.describe(harness, () => {
    test.use({ harnesses: harness });

    test(`↑ steps through a ${harness} chat's prompts, after a reload too`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await send(page, harness, 'first prompt');
      await send(page, harness, 'second prompt');
      await expect(label(page)).toHaveCount(0);

      await stepsBack(page);
      await page.screenshot({ path: test.info().outputPath(`${harness}-history-1-of-2.png`) });
      // ↓ steps forward and past the newest leaves an empty box with no position
      await composer(page).press('ArrowDown');
      await expect(composer(page)).toHaveText('second prompt');
      await composer(page).press('ArrowDown');
      await expect(composer(page)).toHaveText('');
      await expect(label(page)).toHaveCount(0);

      // a reloaded window has no composer state left: the prompts come from the chat's transcript
      await page.reload();
      await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).first().click();
      await expect(page.getByRole('main').getByText(`fake-${harness}: second prompt`, { exact: true })).toBeVisible();
      await stepsBack(page);
      // editing the recalled prompt ends the browse
      await composer(page).press('End');
      await page.keyboard.type(' edited');
      await expect(label(page)).toHaveCount(0);
    });
  });
}

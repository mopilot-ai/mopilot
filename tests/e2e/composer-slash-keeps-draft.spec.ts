// A "/" command typed in front of a draft (Plan mode, by its menu or typed with text) switches the mode and keeps
// the draft in the box, instead of clearing it.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const DRAFT = 'fix the login bug';

test.use({ harnesses: 'codex' });

test('/plan picked in front of a draft, or typed with text, turns plan mode on and keeps the text', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill(DRAFT);
  // the caret back to the start, then the command typed before the draft and picked with Enter
  await composer(page).press('Home');
  await page.keyboard.type('/plan');
  await expect(page.locator('.slash-panel').getByText('Plan mode', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-chip')).toBeVisible();
  await expect(composer(page)).toHaveText(DRAFT);

  // off again, then typed with its text and sent: the mode switches and the text stays, unsent
  await page.locator('.plan-chip').click();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  await composer(page).fill(`/plan ${DRAFT}`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-chip')).toBeVisible();
  await expect(composer(page)).toHaveText(DRAFT);
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
});

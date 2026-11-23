// A whole paragraph selected by triple click still offers the selection toolbar: Chromium ends that selection at the
// start of the block after the reply, outside its text, and the toolbar must clamp it back instead of hiding.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true }).first();

test.use({ harnesses: 'codex' });

test('triple-clicking the last paragraph of a reply shows Reply and Start a side chat', async ({ page }) => {
  await composer(page).fill('summarize the retry loop');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  const turn = page
    .getByRole('main')
    .locator('.main-content .turn')
    .filter({ has: page.getByText('fake-codex: summarize the retry loop', { exact: true }) });
  await turn.getByRole('button', { name: 'Fork chat from here', exact: true }).waitFor({ state: 'visible' });
  const reply = turn.getByText('fake-codex: summarize the retry loop', { exact: true });
  await reply.scrollIntoViewIfNeeded();

  await reply.click({ clickCount: 3 });
  // the repro: the selection's end sits outside the reply's text
  const endsOutside = await reply.evaluate((el) => {
    const range = window.getSelection()!.getRangeAt(0);
    return !el.closest('.md')!.contains(range.endContainer);
  });
  expect(endsOutside).toBe(true);

  const toolbar = page.locator('.selection-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Reply' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Start a side chat' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('triple-click-toolbar.png') });
  await toolbar.getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('.selection-chip').first()).toContainText('1 annotation');
});

// Settings → Show reasoning, in the real app against tests/e2e/fixtures/fake-codex.mjs.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const SUMMARY = 'fake-codex reasoning summary';

/** Sets it from the open chat; Back to app returns to that chat. */
async function setShowReasoning(page: Page, on: boolean) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  const toggle = page.locator('.settings-row', { hasText: 'Show reasoning' }).getByRole('switch');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await expect(transcript(page).getByText('fake-codex: please THINK first', { exact: true })).toBeVisible();
}

test('show-reasoning: a reasoning item shows with the setting on and is hidden with it off', async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await composer(page).fill('please THINK first');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: please THINK first', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

  // on (the default): the finished turn's work holds a "Thought" step that opens to the summary
  await transcript(page)
    .getByRole('button', { name: /^Worked/ })
    .click();
  const thought = transcript(page).getByRole('button', { name: 'Thought' });
  await expect(thought).toBeVisible();
  await thought.click();
  await expect(transcript(page).getByText(SUMMARY)).toBeVisible();

  // off: no reasoning, and no empty "Worked for" to open
  await setShowReasoning(page, false);
  await expect(transcript(page).getByRole('button', { name: /^Worked/ })).toHaveCount(0);
  await expect(transcript(page).getByRole('button', { name: 'Thought' })).toHaveCount(0);
  await expect(transcript(page).getByText(SUMMARY)).toHaveCount(0);

  // back on: it shows again
  await setShowReasoning(page, true);
  await transcript(page)
    .getByRole('button', { name: /^Worked/ })
    .click();
  await expect(transcript(page).getByRole('button', { name: 'Thought' })).toBeVisible();
});

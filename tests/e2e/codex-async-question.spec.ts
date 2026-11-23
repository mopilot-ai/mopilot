// A question Codex asks in an async message while its turn works on waits docked above the composer, as Claude Code
// docks its question card, instead of scrolling away with the work after it; answering sends it as a steer.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

test.use({ harnesses: 'codex' });

test('an async question docks above the composer while the turn works, and its answer steers the turn', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('ASKASYNC SLOW');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const dock = page.locator('.thread-composer-area .question-card');
  await expect(dock.locator('.question-title')).toHaveText('Which color?');
  // the work after the question shows in the turn; the question stays docked, not in the transcript
  await expect(transcript(page).getByText('fake-codex: ASKASYNC SLOW', { exact: true })).toBeVisible();
  await expect(page.locator('.turn .question-card')).toHaveCount(0);
  // the composer stays under it, to write instead
  await expect(composer(page)).toBeVisible();

  await dock.getByRole('button', { name: /^Blue/ }).click();
  await expect(transcript(page).getByText(/fake-codex: Which color\?\s+Blue/)).toBeVisible();
  await expect(page.locator('.answered-card .answered-answer')).toHaveText('Blue');
  await expect(dock).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});

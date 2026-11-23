// /code-review on Claude with a screenshot attached (A6, D-19, D-58): main builds the message with the
// image first and the command last, a BMP becomes PNG, and the findings render in the review card.
// Runs against fake-claude.mjs.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the screenshot becomes PNG through macOS’s sips');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

/** A 2×2 24-bit BMP, a format the Anthropic API doesn't take. */
function bmp(): Buffer {
  const row = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]); // two pixels + padding to 4 bytes
  const pixels = Buffer.concat([row, row]);
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

test.use({ harnesses: 'claude' });

test('/code-review with a BMP screenshot: image first as PNG, command last, findings in the review card', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('warm up');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  const shot = path.join(harness.dir, 'screenshot.bmp');
  fs.writeFileSync(shot, bmp());
  await harness.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any;
  }, shot);
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Files and folders', { exact: true }).click();
  await expect(page.locator('.attachment.image')).toHaveCount(1);

  await composer(page).fill('/code-review low');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = transcript(page).locator('.review-result');
  await expect(card).toContainText('multiplies instead of dividing (review low)');
  // the findings are the card, not a second reply
  await expect(transcript(page).getByText(/multiplies instead of dividing/)).toHaveCount(1);
  const review = harness.claudeLog().find((e: any) => e.kind === 'review') as any;
  expect(review.args).toBe('low');
  expect(review.blocks).toEqual(['image:image/png', 'text']);
});

test('typed /review in an existing Claude chat runs /code-review instead of refusing', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('warm up');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await composer(page).fill('/review');
  await page.keyboard.press('Enter');
  await expect(transcript(page).locator('.review-result')).toContainText('multiplies instead of dividing (review default)');
  await composer(page).fill('/review high');
  await page.keyboard.press('Enter');
  await expect(transcript(page).locator('.review-result').last()).toContainText('(review high)');
  await expect(page.getByText(/isn.t available/)).toHaveCount(0);
  const reviews = harness.claudeLog().filter((e: any) => e.kind === 'review') as any[];
  expect(reviews.map((r) => r.args)).toEqual(['', 'high']);
});

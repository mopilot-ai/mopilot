// Plan mode on Claude Code (A4, D-12): ExitPlanMode shows one plan card with its file, and approving
// it returns the session to the mode the chat had before plan. Runs against fake-claude.mjs.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

// this platform's path separator, as a pattern: '/' on macOS and Linux, '\\' on Windows
const SEP = path.sep.replace(/[\\]/g, '\\\\');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

// "Approve for me" is the chat's mode, so an approved plan should land on auto, not on Claude's own default
test.use({ harnesses: 'claude', seed: { uiState: { prefs: { permission: 'auto-review' } } } });

test('plan round trip: one plan card with its file; approving returns to the mode before plan', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
  await expect(page.locator('.plan-chip')).toBeVisible();
  await send(page, 'PLAN add a hello file');

  const approve = page.getByRole('button', { name: 'Approve plan' });
  await expect(approve).toBeVisible();
  // the plan is on the card once, its file by name (the folder is app data, #1933); the approval only asks
  const card = transcript(page).locator('.plan-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Look at the request: PLAN add a hello file');
  await expect(card.locator('.plan-card-path')).toHaveText('fake-plan.md');
  await expect(card.locator('.plan-card-path')).toHaveAttribute('title', new RegExp(`plans${SEP}fake-plan\\.md$`));
  await expect(page.getByText('Look at the request: PLAN add a hello file')).toHaveCount(1);

  await approve.click();
  await expect(transcript(page).getByText(/plan approved, now auto\]$/)).toBeVisible();
  // Claude reported the new mode, so the chat's plan chip went off by itself
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  // the plan was carried out in that turn, so its card offers no "Implement this plan"
  await expect(card).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Implement this plan' })).toHaveCount(0);

  const answer = harness.claudeLog().find((e: any) => e.kind === 'plan') as any;
  expect(answer.response.behavior).toBe('allow');
  expect(answer.response.updatedPermissions).toEqual([{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  // the session can still go to Full access later in the chat
  const argv = harness.claudeLog().find((e) => e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id='))) as any;
  expect(argv.argv).toContain('--allow-dangerously-skip-permissions');

  // the next message runs out of plan mode
  await send(page, 'and now build it');
  await expect(transcript(page).getByText('fake-claude: and now build it', { exact: true })).toBeVisible();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
});

test('a question card in the middle of a plan keeps Plan mode on (D-3)', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
  await expect(page.locator('.plan-chip')).toBeVisible();

  // the question replaces the composer; answering brings it back with Plan still on
  await send(page, 'ASKMULTI now');
  await page.getByRole('button', { name: 'a.ts' }).click();
  await page
    .locator('.question-card')
    .getByRole('button', { name: /^Submit/ })
    .click();
  await expect(transcript(page).getByText(/\[answers: /)).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('.plan-chip')).toBeVisible();
});

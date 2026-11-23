// Codex Plan, Review and Compact in the real app (WP5-5, A4, A6, A7) against fake-codex.mjs.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const planChip = (page: Page) => page.locator('.plan-chip');
const PROBE = '00000000-0000-0000-0000-000000000000';

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function slash(page: Page, cmd: string) {
  await composer(page).fill(cmd);
  await page.keyboard.press('Enter');
}
const turnStarts = (h: Harness) =>
  h.codexLog().filter((e) => e.method === 'turn/start' && !/as a short chat title/.test(e.params.input?.[0]?.text ?? ''));

test('codex-plan: every turn says its mode; a plan written only as a message is the plan card; Implement this plan runs it in default mode', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-codex: hello', { exact: true })).toBeVisible();
  expect(turnStarts(harness)[0].params.collaborationMode.mode).toBe('default');

  await slash(page, '/plan');
  await expect(planChip(page)).toBeVisible();
  await send(page, 'add a button');
  const card = page.locator('.plan-card');
  await expect(card).toContainText('Change it for: add a button');
  expect(turnStarts(harness)[1].params.collaborationMode).toMatchObject({ mode: 'plan', settings: { model: 'fake-model-1' } });
  // the chip follows the thread's mode, and stays on after the plan
  await expect(planChip(page)).toBeVisible();

  await card.getByRole('button', { name: 'Implement this plan' }).click();
  await expect(transcript(page).getByText('fake-codex: Implement the plan.', { exact: true })).toBeVisible();
  expect(turnStarts(harness)[2].params.collaborationMode.mode).toBe('default');
  await expect(planChip(page)).toHaveCount(0);
  // only the last plan offers to run it
  await expect(page.getByRole('button', { name: 'Implement this plan' })).toHaveCount(0);
});

test('codex-plan: a plan item is the card when the model writes one', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await slash(page, '/plan');
  await send(page, 'PLANITEM refactor');
  await expect(page.locator('.plan-card')).toContainText('Change it for: PLANITEM refactor');
  await expect(page.locator('.plan-card').getByRole('button', { name: 'Implement this plan' })).toBeVisible();
  expect(turnStarts(harness)[0].params.collaborationMode.mode).toBe('plan');
});

test('codex-review-compact: an inline review shows its result once; a compaction you asked for says so', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'hello');
  await expect(transcript(page).getByText('fake-codex: hello', { exact: true })).toBeVisible();

  await slash(page, '/review');
  await page.getByText('Review uncommitted changes', { exact: true }).click();
  const result = transcript(page).locator('.review-result');
  await expect(result).toContainText('[P1] Fake finding: a+b became a-b');
  // the same text as a reply too would show it twice
  await expect(transcript(page).getByText('[P1] Fake finding: a+b became a-b')).toHaveCount(1);
  // (the version probes at startup ask with a thread that doesn't exist)
  const review = harness.codexLog().find((e) => e.method === 'review/start' && e.params.threadId !== PROBE)!;
  expect(review.params).toMatchObject({ target: { type: 'uncommittedChanges' }, delivery: 'inline' });

  await slash(page, '/compact');
  await expect(transcript(page).getByText('Context compacted', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('Context automatically compacted')).toHaveCount(0);
  expect(harness.codexLog().filter((e) => e.method === 'thread/compact/start' && e.params.threadId !== PROBE)).toHaveLength(1);
});

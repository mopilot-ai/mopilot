// Codex goals in the real app against tests/e2e/fixtures/fake-codex.mjs: set, pause and clear.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { expectGoalRunning, goalCard, goalPill } from './fixtures/goal';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Requests to the chat's thread, ignoring the hidden title helper. */
const requests = (h: Harness, method: string) =>
  h.codexLog().filter((e) => e.method === method && !/as a short chat title/.test(e.params?.input?.[0]?.text ?? ''));

test('codex-goal: set on a new chat, pause, then clear', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, '/goal make it SLOW');

  // goal/set starts the turn by itself: one goal/set, no turn/start
  await expect(transcript(page).getByText('fake-codex: make it SLOW', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('/goal make it SLOW', { exact: true })).toBeVisible();
  await expect(goalPill(page)).toHaveAttribute('title', 'make it SLOW');
  await expectGoalRunning(page);
  // the chat's row in the sidebar carries a goal mark while the goal is unfinished
  await expect(page.locator('.row-goal')).toHaveCount(1);
  const sets = requests(harness, 'thread/goal/set');
  expect(sets).toHaveLength(1);
  expect(sets[0].params).toMatchObject({ objective: 'make it SLOW', status: 'active' });
  expect(requests(harness, 'turn/start')).toHaveLength(0);

  // Pause sets paused first, then interrupts the running turn
  await (await goalCard(page)).getByRole('button', { name: 'Pause' }).click();
  await expect((await goalCard(page)).getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(goalPill(page)).toContainText('Paused');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const log = harness.codexLog();
  const paused = log.findIndex((e) => e.method === 'thread/goal/set' && e.params.status === 'paused');
  const interrupt = log.findIndex((e) => e.method === 'turn/interrupt');
  expect(paused).toBeGreaterThanOrEqual(0);
  expect(interrupt).toBeGreaterThan(paused);
  expect(log[interrupt].params.threadId).toBe(sets[0].params.threadId);

  // typed /goal resume and /goal edit act on the goal instead of setting objectives named "resume" and "edit …"
  await send(page, '/goal edit finish it SLOW');
  await expect(await goalCard(page)).toContainText('finish it SLOW');
  await send(page, '/goal pause');
  await expect(goalPill(page)).toContainText('Paused');
  await send(page, '/goal resume');
  await expectGoalRunning(page);
  await send(page, '/goal pause');
  await expect(goalPill(page)).toContainText('Paused');
  const goalSets = requests(harness, 'thread/goal/set');
  expect(goalSets.some((e) => ['resume', 'pause'].includes(e.params.objective) || /^edit /.test(e.params.objective ?? ''))).toBe(false);
  expect(goalSets.some((e) => e.params.objective === 'finish it SLOW' && !('status' in e.params))).toBe(true);

  // "/goal clear" clears instead of setting an objective named "clear"
  await send(page, '/goal clear');
  await expect(goalPill(page)).toHaveCount(0);
  await expect(page.locator('.row-goal')).toHaveCount(0);
  expect(requests(harness, 'thread/goal/clear')).toHaveLength(1);
  expect(requests(harness, 'thread/goal/set').some((e) => e.params.objective === 'clear')).toBe(false);
});

test('codex-goal: /goal budget sets the budget, which only the goal card shows, never the pill', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, '/goal keep going SLOW');
  await expectGoalRunning(page);
  await expect(await goalCard(page)).not.toContainText('token budget');

  await expect((await goalCard(page)).getByRole('button', { name: 'Edit budget' })).toHaveCount(0);
  await send(page, '/goal budget 200k');
  await expect((await goalCard(page)).locator('.goal-budget')).toContainText('200k token budget');
  await expect(goalPill(page)).not.toContainText('token budget');
  const budgets = () => requests(harness, 'thread/goal/set').filter((e) => 'tokenBudget' in e.params);
  await expect.poll(() => budgets().map((e) => e.params.tokenBudget)).toEqual([200000]);
  // only the budget changes: the goal keeps its objective and isn't restarted
  expect(budgets()[0].params).not.toHaveProperty('objective');
  expect(requests(harness, 'turn/start')).toHaveLength(0);

  // later budgets change the card's line, and none removes it
  await send(page, '/goal budget 1.5m');
  await expect.poll(() => budgets().map((e) => e.params.tokenBudget)).toEqual([200000, 1500000]);
  await expect(goalPill(page)).not.toContainText('token budget');
  await send(page, '/goal budget none');
  await expect.poll(() => budgets().map((e) => e.params.tokenBudget)).toEqual([200000, 1500000, null]);
  await expect(await goalCard(page)).not.toContainText('token budget');
  await expect(await goalCard(page)).toContainText('keep going SLOW');
});

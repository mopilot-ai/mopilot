// Background tasks and ultracode on Claude Code (A5, D-15, D-17): Stop ends the turn but not the
// background agent, which is stopped on its own from the tasks pane; ultracode is a session switch.
// Runs against fake-claude.mjs.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
// the running-tasks count in the turn's status line
const tasksPill = (page: Page) => page.locator('.tasks-count');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const controls = (h: Harness, subtype: string) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg.type === 'control_request' && e.msg.request.subtype === subtype)
    .map((e) => (e as any).msg.request);

test.use({ harnesses: 'claude' });

test('a background agent outlives Stop and is stopped from the tasks pane', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'start BGTASK auth');
  await expect(transcript(page).getByText('fake-claude: start BGTASK auth', { exact: true })).toBeVisible();
  // the app declared it renders a per-task stop, so interrupts spare background agents
  expect(controls(harness, 'initialize').some((r) => r.perTaskStopAffordance === true)).toBe(true);

  await expect(tasksPill(page)).toContainText('1 running task');
  // The running agent stays in view after its turn; its row opens the agent's transcript in the side pane.
  const group = transcript(page).locator('.agent-group-head');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await transcript(page).locator('.agent-row', { hasText: 'Explore auth' }).click();
  await expect(page.locator('.agent-page')).toContainText('Read');

  // Stop a turn: the background agent keeps running
  await send(page, 'take it SLOW');
  await expect(transcript(page).getByText('fake-claude: take it SLOW', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect.poll(() => controls(harness, 'interrupt').length).toBe(1);
  await expect(tasksPill(page)).toContainText('1 running task');

  await tasksPill(page).click();
  const row = page.locator('.task-card.running');
  await expect(row).toContainText('Explore auth');
  await row.getByRole('button', { name: 'Stop Explore auth', exact: true }).click();
  // The card moves to Finished, and the count says so for a moment before it goes.
  await expect(page.locator('.task-card.running')).toHaveCount(0);
  await expect(page.locator('.tasks-finished-toggle')).toHaveText(/^\s*Finished\s*1\s*$/);
  await expect(tasksPill(page)).toHaveCount(0);
  expect(controls(harness, 'stop_task').map((r) => r.task_id)).toHaveLength(1);
  expect(
    harness
      .claudeLog()
      .filter((e: any) => e.kind === 'task')
      .map((e: any) => e.status),
  ).toEqual(['stopped']);
});

test('a background workflow is a Workflow card with its stage and subtasks, each stoppable', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'start BGWORKFLOW release');
  await expect(transcript(page).getByText('fake-claude: start BGWORKFLOW release', { exact: true })).toBeVisible();
  await expect(tasksPill(page)).toContainText('3 running tasks');
  await tasksPill(page).click();
  const card = page
    .locator('.task-card.running')
    .filter({ has: page.locator('.task-opener', { hasText: 'Run the release workflow' }) })
    .first();
  await expect(card.locator('.task-type').first()).toHaveText('Workflow');
  // The collapsed card no longer shows the stage; expanding it shows the workflow's summary.
  await card.getByRole('button', { name: 'Run the release workflow', exact: true }).click();
  await expect(card.locator('.task-summary').first()).toHaveText('Stage 2 of 3');
  await expect(card.locator('.task-children > .task-card')).toHaveCount(2);
  // A subtask stops on its own; the workflow keeps running.
  await card.locator('.task-children .task-stop').first().click();
  await expect(card.locator('.task-children > .task-card.running')).toHaveCount(1);
  await expect(card.locator('.task-children > .task-card.finished')).toContainText('Stopped');
  expect(controls(harness, 'stop_task')).toHaveLength(1);
});

test('ultracode is a session switch read from getSettings', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
  // the session reported its settings (getSettings) after its first init
  await expect.poll(() => controls(harness, 'get_settings').length).toBeGreaterThan(0);

  await composer(page).fill('/');
  await page.locator('.slash-panel').getByText('Ultracode', { exact: true }).click();
  await expect.poll(() => controls(harness, 'apply_flag_settings').map((r) => r.settings)).toContainEqual({ ultracode: true });
  // the menu shows it on now
  await composer(page).fill('/');
  await expect(page.locator('.slash-panel').locator('.add-panel-item', { hasText: 'Ultracode' }).locator('.add-panel-check')).toHaveCount(
    1,
  );
});

test('a second Esc within 2 seconds offers to stop all background tasks (D-18)', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'start BGTASK auth');
  await expect(tasksPill(page)).toContainText('1 running task');
  await composer(page).focus();
  await page.keyboard.press('Escape');
  await expect(tasksPill(page)).not.toContainText('Stop all');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tasks-bar')).toContainText('Stop all 1 background tasks?');
  await page.locator('.tasks-bar').getByRole('button', { name: 'Stop all' }).click();
  // Wait for the stop to be sent before checking that the count settles and goes.
  await expect.poll(() => controls(harness, 'stop_task').length).toBe(1);
  await expect(page.locator('.tasks-bar')).toHaveCount(0);
  await expect(tasksPill(page)).toHaveCount(0);
  expect(controls(harness, 'stop_task')).toHaveLength(1);
});

test('the task panel shows a card per task kind', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'start BGTASK auth');
  await expect(tasksPill(page)).toContainText('1 running task');
  await tasksPill(page).click();
  const card = page.locator('.task-card.running', { hasText: 'Explore auth' });
  await expect(card.locator('.task-type')).toHaveText('Agent');
  await expect(card.getByRole('button', { name: 'Stop Explore auth', exact: true })).toBeVisible();
});

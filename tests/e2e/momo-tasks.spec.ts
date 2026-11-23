// MoMo's Tasks tab (A1), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1): a promise the user made becomes an open loop (the memory pass is a data-only background chat the fake answers), and the Tasks tab lists it under Needs you with its own Done, Snooze and Dismiss. Each of the three is the user's own act: Done closes the loop for good, Snooze takes the task out of the list until its time (Memory says when), Dismiss closes it as dismissed; the tab itself marks nothing done. A screenshot of the list is saved.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChatSession, openMomo, settingsGroup } from './fixtures/momo';

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000' },
  seed: { files: (d) => codexCliLogin(d), uiState: { prefs: { momo: { routines: { proactivity: 'default', quietHours: null } } } } },
});

const WORDS = 'call the landlord by Wednesday';

/** The user promises something in MoMo's chat, the memory pass keeps it as an open loop, and Tasks lists it: returns its task row and the Needs you group. */
async function promiseOnTasks(page: Page) {
  await openMomo(page);
  const { chat, send } = await momoChatSession(page);
  await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });
  // the fake says "Noted." instead of echoing, so the words are in the user's message alone
  await send(`NOECHO I'll ${WORDS}`);
  await expect(chat.getByText('Noted.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  // the memory pass keeps the promise as an open loop, which Memory shows
  await goToMomoView(page, 'Memory');
  await expect(settingsGroup(page, 'Open loops').locator('.momo-fact[data-loop]').filter({ hasText: WORDS })).toBeVisible({
    timeout: 90_000,
  });
  // Tasks lists it under Needs you, with the loop's own buttons and no other way to complete it
  await goToMomoView(page, 'Tasks');
  const needs = settingsGroup(page, 'Needs you');
  const task = needs.locator('[data-task^="loop:"]').filter({ hasText: WORDS });
  await expect(task).toBeVisible({ timeout: 15_000 });
  await expect(task.getByRole('button')).toHaveText(['Done', 'Snooze', 'Dismiss', 'Add to Calendar', 'Remind me']);
  return { task, needs };
}

/** The day a time falls on here, as the Memory tab names it (YYYY-MM-DD). */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('Done on a task closes the loop for good and the task goes', async ({ page }) => {
  test.setTimeout(240_000);
  const { task, needs } = await promiseOnTasks(page);
  await page.screenshot({ path: test.info().outputPath('momo-tasks.png') });
  await task.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(task).toHaveCount(0, { timeout: 15_000 });
  await expect(needs.getByText('Nothing needs you')).toBeVisible();
  await goToMomoView(page, 'Memory');
  await expect(page.locator('.momo-loops-closed summary')).toHaveText('Closed (1)');
});

test('Snooze takes the task out of the list until its time, and Memory says when', async ({ page }) => {
  test.setTimeout(240_000);
  const { task, needs } = await promiseOnTasks(page);
  await task.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(task).toHaveCount(0, { timeout: 15_000 });
  await expect(needs.getByText('Nothing needs you')).toBeVisible();
  // Memory keeps the loop open, snoozed to a later day, so it does not come back before then
  await goToMomoView(page, 'Memory');
  const loop = settingsGroup(page, 'Open loops').locator('.momo-fact[data-loop]').filter({ hasText: WORDS });
  const chip = loop.locator('.momo-chip').filter({ hasText: /^Snoozed to / });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  const until = (await chip.textContent())!.replace('Snoozed to ', '');
  expect(until > dayOf(Date.now())).toBe(true);
  // and Tasks, read again, still leaves it out
  await goToMomoView(page, 'Tasks');
  await expect(settingsGroup(page, 'Needs you').getByText('Nothing needs you')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-task^="loop:"]')).toHaveCount(0);
});

test('Dismiss takes the task out of the list and Memory shows the loop dismissed', async ({ page }) => {
  test.setTimeout(240_000);
  const { task, needs } = await promiseOnTasks(page);
  await task.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(task).toHaveCount(0, { timeout: 15_000 });
  await expect(needs.getByText('Nothing needs you')).toBeVisible();
  await goToMomoView(page, 'Memory');
  const closed = page.locator('.momo-loops-closed');
  await expect(closed.locator('summary')).toHaveText('Closed (1)');
  await closed.locator('summary').click();
  const loop = closed.locator('.momo-fact[data-loop]').filter({ hasText: WORDS });
  await expect(loop.locator('.momo-chip').filter({ hasText: /^Dismissed$/ })).toBeVisible();
  await expect(loop.getByRole('button')).toHaveText(['Reopen']);
});

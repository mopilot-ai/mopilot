// MoMo's four-tab Tasks panel (M0a), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1) with `momo.tasksPanel` on: a promise the user made becomes an open loop (the memory pass is a data-only background chat the fake answers); Tasks shows Active (empty), Up next (the loop, which is not due soon), Scheduled and Resolved; the loop's own Done moves it to Resolved, where Reopen brings it back to Up next; the empty Up next, Scheduled and Resolved lines are the design's words; nothing here marks anything done but the user's own click. A screenshot of the panel is saved.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChatSession, openMomo } from './fixtures/momo';

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { tasksPanel: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

const WORDS = 'call the landlord by Wednesday';

/** The user promises something in MoMo's chat; the memory pass keeps it as an open loop. */
async function promise(page: Page) {
  await openMomo(page);
  const { chat, send } = await momoChatSession(page);
  await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });
  // the fake says "Noted." instead of echoing, so the words are in the user's message alone
  await send(`NOECHO I'll ${WORDS}`);
  await expect(chat.getByText('Noted.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
}

test('the four tabs: the promise waits in Active or Up next by its due day, Done moves it to Resolved, Reopen brings it back', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await promise(page);
  await goToMomoView(page, 'Tasks');
  const tabs = page.getByRole('tablist', { name: 'Tasks' });
  await expect(tabs.getByRole('tab')).toHaveText([/^Active/, /^Up next/, /^Scheduled/, /^Resolved/]);
  const task = page.locator('[data-task^="loop:"]').filter({ hasText: WORDS });
  // the memory pass keeps the promise as an open loop: due within a day it is Active, otherwise Up next (its day depends on today)
  const home = /^(Active|Up next)/;
  await expect(tabs.getByRole('tab', { name: home }).filter({ hasText: /\d/ })).toHaveCount(1, { timeout: 90_000 });
  const homeTab = tabs.getByRole('tab', { name: home }).filter({ hasText: /\d/ });
  await homeTab.click();
  await expect(task).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('momo-tasks-panel.png') });
  // the loop's own Done is the user's act; the panel marks nothing itself
  await task.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(task).toHaveCount(0, { timeout: 15_000 });
  await tabs.getByRole('tab', { name: /^Resolved/ }).click();
  await expect(task).toBeVisible({ timeout: 15_000 });
  await expect(task.getByRole('button')).toHaveText(['Reopen']);
  await task.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(task).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Nothing resolved yet.')).toBeVisible();
  await homeTab.click();
  await expect(task).toBeVisible({ timeout: 15_000 });
  // Up next says what it holds when it is empty, and Scheduled has no routine here (none was approved)
  await tabs.getByRole('tab', { name: /^Scheduled/ }).click();
  await expect(page.getByText('No routines yet.')).toBeVisible();
});

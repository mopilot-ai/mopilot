// A routine's row menu in the Tasks panel's Scheduled tab (#4975), on the fake harness for an invited account (MOPILOT_MOMO_DEV=1): a routine MoMo proposed and the user approved in Settings is listed under Scheduled with a menu; View history says it hasn’t run yet, Run now starts a run (a toast says so) and View history then lists it, Pause says so and the row reads Paused, Resume brings its next run back, Rename opens the name on the row and a Save shows the new name, and Delete removes it at once with no confirm. Pictures of the menu, the history dialog, the started run, the renamed row and the empty tab are saved.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoSettings, goToMomoView, momoChatSession, openMomo } from './fixtures/momo';

// needs a Mac, as the routines spec does: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { tasksPanel: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

const PROPOSE = { name: 'Files check', prompt: 'Tell me if anything in my Files folder changed.', time: '09:00', sources: ['files'] };

test('Run now, View history, Pause, Resume, Rename and Delete from a routine’s row menu', async ({ page }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  const { chat, send } = await momoChatSession(page);
  await send(`CUCALL momo_routine_propose ${JSON.stringify(PROPOSE)}`);
  await expect(chat.getByText(/Proposed the routine “Files check”/)).toBeVisible({ timeout: 30_000 });
  await goToMomoSettings(page, 'Routines');
  const card = page.getByRole('region', { name: 'Files check', exact: true });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card.getByText('Needs your approval')).toHaveCount(0);

  // Settings is the app's own page: back to the app, then MoMo's Tasks
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await goToMomoView(page, 'Tasks');
  await page.getByRole('tab', { name: /^Scheduled/ }).click();
  const row = page.locator('[data-task^="routine:"]', { hasText: 'Files check' });
  const menu = () => row.getByRole('button', { name: 'More for Files check', exact: true });
  const pick = (name: string) => page.getByRole('menuitem', { name, exact: true });
  const toast = (text: string) => page.getByText(text, { exact: true });
  await expect(row).toContainText('Next');

  // the menu, in the design's order
  await menu().click();
  await expect(page.getByRole('menuitem')).toHaveText(['Run now', 'Pause', 'Rename', 'View history', 'Delete']);
  await page.screenshot({ path: test.info().outputPath('momo-routine-menu.png') });

  // View history before any run: it hasn't run yet
  await pick('View history').click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Files check');
  await expect(dialog).toContainText('Hasn’t run yet');
  await page.screenshot({ path: test.info().outputPath('momo-routine-history-empty.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Run now: a toast says it started, and the fake harness's run shows in the history (still going or already finished)
  await menu().click();
  await pick('Run now').click();
  await expect(toast('Started “Files check”')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-routine-run-now.png') });
  await menu().click();
  await pick('View history').click();
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('listitem')).toContainText(/· (Working|Finished)/);
  await page.screenshot({ path: test.info().outputPath('momo-routine-history.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // the run ends on the fake harness, and the row goes back to its next time (a row with a run going says Working instead)
  await expect(row).toContainText('Next', { timeout: 60_000 });
  await menu().click();
  await pick('Pause').click();
  await expect(toast('Paused Files check')).toBeVisible();
  await expect(row).toContainText('Paused');
  await menu().click();
  await pick('Resume').click();
  await expect(toast('Resumed Files check')).toBeVisible();
  await expect(row).toContainText('Next');

  // Rename on the row: Cancel leaves the name, Save keeps the new one
  await menu().click();
  await pick('Rename').click();
  await row.getByRole('textbox', { name: 'Routine name' }).fill('Folder check');
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row).toContainText('Files check');
  await menu().click();
  await pick('Rename').click();
  await row.getByRole('textbox', { name: 'Routine name' }).fill('Folder check');
  await page.screenshot({ path: test.info().outputPath('momo-routine-rename.png') });
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  const renamed = page.locator('[data-task^="routine:"]', { hasText: 'Folder check' });
  await expect(renamed).toBeVisible();

  // Delete: at once, with no confirm
  await renamed.getByRole('button', { name: 'More for Folder check', exact: true }).click();
  await pick('Delete').click();
  await expect(toast('Deleted Folder check')).toBeVisible();
  await expect(renamed).toHaveCount(0);
  await expect(page.getByText('No routines yet.')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-routine-deleted.png') });
});

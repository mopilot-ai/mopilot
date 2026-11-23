// The exit gate in the real app: Quit with a goal running lists what would stop, Cancel keeps the
// app open, and Quit pauses the Codex goal before the app exits (A20, D-79).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { expectGoalRunning } from './fixtures/goal';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.use({ seed: { uiState: { prefs: { confirmClose: 'shortcut' } } } });

test('exit-gate: Quit lists the running turn and goal, Cancel keeps the app, Quit pauses the goal', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('/goal make it SLOW');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectGoalRunning(page);

  const quit = () => harness.app.evaluate(({ app }) => app.quit());
  await quit();
  const dialog = page.getByRole('alertdialog', { name: 'Quit MoPilot?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 turn and 1 goal will stop. Goals are paused, not lost.');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expectGoalRunning(page);
  expect(harness.codexLog().some((e) => e.method === 'thread/goal/set' && e.params.status === 'paused')).toBe(false);

  const closed = harness.app.waitForEvent('close');
  await quit();
  await dialog.getByRole('button', { name: 'Quit' }).click();
  await closed;
  expect(harness.codexLog().some((e) => e.method === 'thread/goal/set' && e.params.status === 'paused')).toBe(true);
});

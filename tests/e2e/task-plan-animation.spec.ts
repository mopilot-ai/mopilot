// Verifies that an unfinished task plan keeps visibly rotating after its parent turn ends while a background agent runs.
import { test, expect } from './fixtures/app';

test.use({ harnesses: 'claude', seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });

test('the plan spinner moves after the reply ends, then disappears when background work stops', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('--fs-chat', '24px');
  const prompt = [
    'BGTASK animation',
    `CUCALL update_task_list ${JSON.stringify({ items: [{ content: 'Wait for background work', status: 'in_progress' }] })}`,
  ].join('\n');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.tasks-count')).toContainText('1 running task');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const plan = page.getByRole('region', { name: 'Task list' });
  const spinner = plan.locator('svg.spinner:not(.still)');
  await expect(spinner).toBeVisible();
  // Open the side panel too: the marker must remain visible at the runner's narrow window and largest chat font.
  await page.locator('.tasks-count').click();
  await expect(page.locator('.task-card.running')).toBeVisible();
  await expect(spinner).toBeVisible();
  const first = await spinner.evaluate((el) => getComputedStyle(el).transform);
  await expect.poll(() => spinner.evaluate((el) => getComputedStyle(el).transform)).not.toBe(first);
  await page.screenshot({ path: test.info().outputPath('background-plan-spinning.png') });
  await page.getByRole('button', { name: 'Stop Explore animation', exact: true }).click();
  await expect(plan).toHaveCount(0);
});

// CD task-plan markers: running work rotates, stopped/old plans use a static status glyph, and refreshed work rotates again.
import { test, expect } from './fixtures/app';
import { taskPlanEvidence } from './fixtures/taskPlanEvidence';
test.afterEach(async ({ harness }, info) => taskPlanEvidence(harness, info));

for (const kind of ['codex', 'claude'] as const) {
  test.describe(kind, () => {
    test.use({ harnesses: kind, seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });

    test('an old plan replaces its loading ring and a refreshed plan restores motion', async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await expect(page.locator('html')).toHaveCSS('--fs-chat', '24px');
      const plan = page.getByRole('region', { name: 'Task list' });
      await expect(plan).toHaveCount(0);
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const send = async (text: string) => {
        await composer.fill(text);
        await composer.press('Enter');
      };
      const items = [
        { content: 'Check pull requests', status: 'completed' },
        { content: 'Resolve conflicts', status: 'completed' },
        { content: 'Push the branch', status: 'completed' },
        { content: 'Wait for checks', status: 'in_progress' },
        { content: 'Build the package', status: 'pending' },
      ];
      const update = (done = false) => {
        const call = `CUCALL update_task_list ${JSON.stringify({ items: done ? items.map((s) => ({ ...s, status: 'completed' })) : items })}`;
        // Consecutive snapshots exercise repeated updates without duplicating the list; use the fake's full-line call path.
        return `${call}\n${call}`;
      };
      await send(`SLOW\n${update()}`);
      // Keep Summary open at the narrow, large-font layout; reclaim the left sidebar's width (#2461).
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await expect(page.getByRole('complementary')).toBeHidden();
      await expect(page.locator('.summary-slot')).toBeVisible();
      const current = plan.locator('.todo-step.inProgress');
      const spinner = current.locator('svg.spinner:not(.still)');
      await expect(spinner).toBeVisible();
      await expect(plan.locator('.todo-step')).toHaveCount(items.length);
      const first = await spinner.evaluate((el) => getComputedStyle(el).transform);
      await expect.poll(() => spinner.evaluate((el) => getComputedStyle(el).transform)).not.toBe(first);
      await expect(plan.locator('.todo-step.pending svg.dotted-ring')).toBeVisible();

      // Both snapshots must be accepted before Stop, including the second one after the first painted the list.
      await expect
        .poll(async () => ((await page.getByRole('main').innerText()).match(/A list does not schedule execution/g) ?? []).length)
        .toBe(2);

      // Enter/Escape remain normal user actions with the optional Summary panel open at the narrow viewport.
      await composer.press('Escape');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(current.locator('svg.dotted-ring')).toBeVisible();
      await expect(plan.locator('svg.spinner')).toHaveCount(0);

      // The next message starts other work without updating the old list, as in the reported pairing chat.
      await send('SLOW continue investigating the pairing question');
      await expect(plan.getByText('Plan from before your last message', { exact: true })).toBeVisible();
      await expect(current.locator('svg.dotted-ring')).toBeVisible();
      await expect(plan.locator('svg.spinner')).toHaveCount(0);
      await expect(current.getByRole('img', { name: 'In progress', exact: true })).toBeVisible();
      await current.locator('svg.dotted-ring').scrollIntoViewIfNeeded();
      await expect(current.locator('svg.dotted-ring')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath(`${kind}-old-plan-static.png`) });
      await composer.press('Escape');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(plan).toHaveCount(0);

      await send(`SLOW\n${update()}`);
      await expect(spinner).toBeVisible();
      await expect(plan.getByText('Plan from before your last message', { exact: true })).toHaveCount(0);
      const resumed = await spinner.evaluate((el) => getComputedStyle(el).transform);
      await expect.poll(() => spinner.evaluate((el) => getComputedStyle(el).transform)).not.toBe(resumed);
      await composer.press('Escape');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      // Observe accepted completion while the turn is alive; a hidden stale list alone proves nothing.
      await send(`SLOW\n${update(true)}`);
      await expect(plan.locator('.todo-step.completed')).toHaveCount(items.length);
      await expect(plan.locator('svg.spinner, svg.dotted-ring')).toHaveCount(0);
      await composer.press('Escape');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(plan).toHaveCount(0);
    });
  });
}

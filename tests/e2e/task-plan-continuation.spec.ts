// Real app recovery: stopped plans can resume, and a durable PR merge continuation wakes and completes a plan once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { taskPlanEvidence } from './fixtures/taskPlanEvidence';
test.afterEach(async ({ harness }, info) => taskPlanEvidence(harness, info));
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-plan-pr-'));
const { dir: bin } = fakeGhBin(path.join(root, 'bin'));
const prState = path.join(root, 'pr.json');

for (const kind of ['codex', 'claude'] as const) {
  test.describe(kind, () => {
    test.use({
      harnesses: kind,
      shellPath: [bin],
      env: { PATH: withPath([bin]), FAKE_GH_STATE_FILE: prState },
      seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0, theme: kind === 'codex' ? 'light' : 'dark' } } },
    });
    test('paused plans resume and merge success continues authorized work exactly once', async ({ page }) => {
      fs.writeFileSync(prState, JSON.stringify({ state: 'OPEN', statusCheckRollup: [] }));
      await page.setViewportSize({ width: 1024, height: 682 });
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const send = async (text: string) => {
        await composer.fill(text);
        await composer.press('Enter');
      };
      const plan = page.getByRole('region', { name: 'Task list' });
      const items = [
        { content: 'Wait for the tested merge', status: 'in_progress' },
        { content: 'Build the authorized package', status: 'pending' },
      ];
      const update = (completed = false) =>
        `CUCALL update_task_list ${JSON.stringify({ items: completed ? items.map((i) => ({ ...i, status: 'completed' })) : items })}`;
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await expect(page.locator('html')).toHaveCSS('--fs-chat', '24px');
      await send(`SLOW\n${update()}\n${update()}`);
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await expect(plan.locator('.todo-step')).toHaveCount(2);
      // Waiting for both real tool receipts before Stop prevents a late initial snapshot from racing the next turn.
      await expect
        .poll(async () => ((await page.getByRole('main').innerText()).match(/A list does not schedule execution/g) ?? []).length)
        .toBe(2);
      await composer.press('Escape');
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(plan.getByText('Paused', { exact: true })).toBeVisible();
      await expect(plan.locator('svg.spinner')).toHaveCount(0);
      const resume = plan.getByRole('button', { name: 'Continue task', exact: true });
      await resume.scrollIntoViewIfNeeded();
      await expect(resume).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`${kind}-paused-recovery.png`) });
      await resume.click();
      await expect(page.getByRole('main').getByText('Continue task', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

      // The follow-up itself uses the same real task tool, so the check proves actual list completion, not only a wake-up message.
      const continuation = { when: 'merged', message: `Verify the authorized next step.\n${update(true)}\n${update(true)}` };
      await send(`${update()}\nCUCALL set_pr_monitor ${JSON.stringify({ url: PR_URL, continuation })}`);
      await expect(page.getByText('Waiting for PR merge', { exact: true })).toBeVisible();
      fs.writeFileSync(prState, JSON.stringify({ state: 'MERGED', statusCheckRollup: [] }));
      const pr = page.getByRole('group', { name: 'Pull request controls' });
      await pr.getByRole('button', { name: 'More PR options' }).click();
      await page.getByText('Refresh status', { exact: true }).click();
      const notice = page.locator('[data-kind=authored][data-author=mopilot]').filter({ hasText: 'Continuing task' });
      await expect(notice).toHaveCount(1);
      if (!(await page.locator('.titlebar-main').getAttribute('class'))?.includes('sidebar-open'))
        await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await expect(page.getByRole('complementary')).toBeVisible();
      await expect(pr).toBeVisible();
      const disclosure = notice.getByRole('button', { name: 'Continuing task', exact: true });
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await expect(notice.locator('.peer-message-head, .side-session-title, .side-session-toggle')).toHaveCount(0);
      await expect(notice).toHaveText('Continuing task');
      const geometry = await notice.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el.querySelector('button')!).lineHeight),
          background: style.backgroundColor,
          border: style.borderTopWidth,
          width: el.getBoundingClientRect().width,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
        };
      });
      expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
      expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
      expect(geometry.border).toBe('0px');
      expect(geometry.width).toBeLessThan(500);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      await disclosure.focus();
      await disclosure.press('Enter');
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(notice.locator('.step-body')).toHaveText('The requested PR condition is met. Continuing the authorized next steps.');
      await expect(notice).not.toContainText('Verify the current PR head');
      await page.screenshot({ path: test.info().outputPath(`${kind}-continuation-details.png`) });
      await disclosure.press('Space');
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await expect(notice.locator('.step-body')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${kind}-compact-continuation.png`) });
      await expect(
        page
          .getByRole('main')
          .getByText(/PR continuation:/)
          .first(),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect
        .poll(async () => ((await page.getByRole('main').innerText()).match(/All listed steps are completed/g) ?? []).length)
        .toBe(2);
      await expect(plan).toHaveCount(0);
      await pr.getByRole('button', { name: 'More PR options' }).click();
      await expect(page.getByText('Cancel continuation', { exact: true })).toHaveCount(0);
      await page.getByText('Refresh status', { exact: true }).click();
      await expect(page.getByText('Continuation started', { exact: true })).toHaveCount(0);
      const chatId = await page.locator('.thread-view[data-thread-id]').getAttribute('data-thread-id');
      await page.reload();
      // Reload returns to the configured default page. Reopen the same persisted chat before checking its history.
      // Wait for saved preferences, then read the actual open state rather than the exiting sidebar's presence.
      await expect(page.locator('html')).toHaveCSS('--fs-chat', '24px');
      const sidebar = page.getByRole('complementary');
      if (!(await page.locator('.titlebar-main').getAttribute('class'))?.includes('sidebar-open'))
        await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      await sidebar
        .locator(`[data-sidebar-chat=${JSON.stringify(chatId)}]`)
        .first()
        .click();
      await expect(notice).toHaveCount(1);
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await expect(notice.locator('.peer-message-head')).toHaveCount(0);
      await expect(plan).toHaveCount(0);
    });
  });
}

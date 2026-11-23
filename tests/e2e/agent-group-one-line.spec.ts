// A Claude turn whose only work is a foreground sub-agent shows one running line, in the real app against
// tests/e2e/fixtures/fake-claude.mjs (FGTASK): one collapsed status row below the task list carries its name and clock.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
/** every running line and clock: a group's row or header, and the status line under the task list */
const LINES = '.claude-activity, .agent-group-head.running';
const CLOCKS = '.claude-activity-time, .agent-group-head [role="timer"]';
const SLOT = '.turn-status-slot .claude-activity';

test.use({ harnesses: 'claude', seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });

/** The most running lines, clocks and status lines seen at once, checked every 50 ms in the page. */
async function watch(page: Page) {
  await page.evaluate(
    ({ lines, clocks, slot }) => {
      const w = window as unknown as { __most: Record<string, number> };
      w.__most = { lines: 0, clocks: 0, slot: 0 };
      const shown = (s: string) => [...document.querySelectorAll<HTMLElement>(s)].filter((e) => e.offsetParent !== null).length;
      setInterval(() => {
        for (const [k, s] of Object.entries({ lines, clocks, slot })) w.__most[k] = Math.max(w.__most[k], shown(s));
      }, 50);
    },
    { lines: LINES, clocks: CLOCKS, slot: SLOT },
  );
  return () => page.evaluate(() => (window as unknown as { __most: Record<string, number> }).__most);
}

test('a foreground sub-agent keeps one collapsed running line below the task list through its reply', async ({ page, harness }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const taskList = `CUCALL update_task_list ${JSON.stringify({ items: [{ content: 'Find the memory design', status: 'in_progress' }] })}`;
  await composer(page).fill(`FGTASK find the memory design\n${taskList}`);
  await composer(page).press('Enter');
  const head = transcript(page).locator(SLOT);
  const allow = page.locator('.approval-card').getByRole('button', { name: /Allow once/ });
  await expect(head.filter({ hasText: 'memory' }).or(allow).first()).toBeVisible({ timeout: 20_000 });
  if (await allow.isVisible()) await allow.click();
  await expect(head).toContainText('memory');
  const tasks = page.getByRole('region', { name: 'Task list' });
  await expect(tasks).toBeVisible();
  await expect
    .poll(async () => {
      const [row, plan] = await Promise.all([head.boundingBox(), tasks.boundingBox()]);
      return !!row && !!plan && row.y >= plan.y + plan.height;
    })
    .toBe(true);
  // the label stays on one line: clamped to one line (src/styles/app/motion.css), and its rendered height is under two font sizes (a second line would be at least 2.4)
  const label = head.locator('.claude-activity-label');
  await expect(label).toHaveCSS('-webkit-line-clamp', '1');
  const oneLine = await label.evaluate((el) => el.getBoundingClientRect().height < Number.parseFloat(getComputedStyle(el).fontSize) * 2);
  expect(oneLine, 'the running label renders on one line').toBe(true);
  const most = await watch(page);
  // past both clocks the bug showed (the status line's from 2 s, a row's from 5 s)
  await page.waitForTimeout(7000);
  await page.screenshot({ path: test.info().outputPath('sub-agent-running.png') });
  await expect(head.locator('.claude-activity-time')).toBeVisible();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript(page).locator('.work .claude-activity, .agent-group-head.running')).toHaveCount(0);
  await expect(page.locator('.agent-row:visible')).toHaveCount(0);
  await expect(page.locator(`${CLOCKS}`).filter({ visible: true })).toHaveCount(1);
  await expect(page.locator(SLOT)).toHaveCount(1);
  expect(await most()).toEqual({ lines: 1, clocks: 1, slot: 1 });

  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText(/^fake-claude: FGTASK find the memory design/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.locator(LINES).filter({ visible: true })).toHaveCount(0);
  // from the sub-agent's end through the reply there is never a second running line or clock: the group's row hands the
  // turn's one line to the waiting line while the reply streams (statusSlot.tsx: the slot holds the waiting line between
  // groups), so the slot may hold that line then, but never beside the group's running header
  const after = await most();
  expect(after.lines).toBe(1);
  expect(after.slot).toBe(1);
  expect(after.clocks).toBe(1);
});

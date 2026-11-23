// The live status row at the bottom of a running Claude turn sits one row-gap under the row above it, as Claude Desktop's (#5342): measured in the real app against tests/e2e/fixtures/fake-claude.mjs, in CSS px (the app runs at 2x; every number is also exact at 1x).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

test.use({ harnesses: 'claude' });

/** Claude Desktop's numbers (its shipped CSS, #5342): 15.75px from the last row to the live row, a 28px row with its words centred, the words 19.75px under the row above (a bubble) within a pixel. */
function expectLikeClaudeDesktop(m: Awaited<ReturnType<typeof measure>>) {
  const bubble = m.rows.find((r) => r.cls === 'user-bubble')!;
  expect(m.status!.top - bubble.bottom).toBeCloseTo(15.75, 0);
  expect(m.status!.height).toBe(28);
  expect(Math.abs(m.label!.top - bubble.bottom - 19.75)).toBeLessThanOrEqual(1);
  expect(m.markCenter).toBe(m.labelCenter);
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

/** The rows of the live turn in reading order with their boxes, and the status row's mark and label boxes. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2) };
    };
    const visible = (e: Element) => (e as HTMLElement).offsetParent !== null && e.getBoundingClientRect().height > 0;
    const rows = [
      ...document.querySelectorAll('.user-bubble, .work, .work > *, .work .step-row, .work .step-group, .turn-box, .turn-status-slot'),
    ]
      .filter(visible)
      .map((e) => ({ cls: (e.className || '').toString().slice(0, 60), text: (e.textContent || '').trim().slice(0, 40), ...box(e) }))
      .sort((a, b) => a.top - b.top);
    const status = document.querySelector('.turn-status-slot .claude-activity');
    const mark = status?.querySelector('.claude-activity-mark');
    const label = status?.querySelector('.claude-activity-label, .claude-activity-thinking');
    return {
      dpr: window.devicePixelRatio,
      rows,
      status: status && box(status),
      mark: mark && box(mark),
      label: label && box(label),
      markCenter: mark ? +((mark.getBoundingClientRect().top + mark.getBoundingClientRect().bottom) / 2).toFixed(2) : null,
      labelCenter: label ? +((label.getBoundingClientRect().top + label.getBoundingClientRect().bottom) / 2).toFixed(2) : null,
    };
  });
}

test('measure the live status row against the row above it while a command runs', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('RUNCMDSTREAM go');
  await composer(page).press('Enter');
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.waitForTimeout(7000);
  const live = await measure(page);
  console.log(`GAPS-LIVE ${JSON.stringify(live)}`);
  expectLikeClaudeDesktop(live);
  await page.screenshot({ path: test.info().outputPath('status-row-live.png') });
  harness.releaseClaudeCommand();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  const done = await measure(page);
  console.log(`GAPS-DONE ${JSON.stringify(done)}`);
});

test('measure the live status row under a settled step row while the model thinks on', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('RUNCMD AFTERTOOLHOLD go');
  await composer(page).press('Enter');
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.waitForTimeout(7000);
  const afterTool = await measure(page);
  console.log(`GAPS-AFTERTOOL-LIVE ${JSON.stringify(afterTool)}`);
  expectLikeClaudeDesktop(afterTool);
  await page.screenshot({ path: test.info().outputPath('status-row-after-tool.png') });
  harness.releaseClaudeCommand();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  console.log(`GAPS-AFTERTOOL-DONE ${JSON.stringify(await measure(page))}`);
});

test('measure the live status row under a collapsed group of settled steps', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('RUNCMD EDITFILE AFTERTOOLHOLD go');
  await composer(page).press('Enter');
  // the command and the file write each ask once
  const allow = page.locator('.approval-card').getByRole('button', { name: /Allow once/ });
  await allow.click({ timeout: 20_000 });
  await allow.click({ timeout: 20_000 }).catch(() => undefined);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.waitForTimeout(7000);
  const steps = await measure(page);
  console.log(`GAPS-STEPS-LIVE ${JSON.stringify(steps)}`);
  expectLikeClaudeDesktop(steps);
  await page.screenshot({ path: test.info().outputPath('status-row-steps.png') });
  harness.releaseClaudeCommand();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
});

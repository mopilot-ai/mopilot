// The composer context popover's usage-limit bars share one set of columns: rows with different label and percent widths start and end their bars at the same x.
// e2e-covers: src/components/composer/ContextRing.tsx src/components/composer/ComposerPlanLimits.tsx src/styles/app/context-summary.css
import { test, expect } from './fixtures/app';
import { emptySnapshot, withClaudeBreakdown } from '../../shared/contextSnapshot.mjs';

const SESSION = '7a1c2e3d-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
// the usage reading counts reset times in epoch seconds
const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: [
      {
        id: SESSION,
        cwd: 'old-project',
        title: 'Limit bars check',
        turns: ['an old message'],
      },
    ],
    uiState: {
      summaryOpen: true,
      claudeUsage: {
        default: {
          windows: [
            { label: 'Opus', usedPercent: 100, resetsAt },
            { label: 'Design', usedPercent: 91, resetsAt },
            { label: 'Weekly Fable', usedPercent: 5, resetsAt },
            { label: 'Routine runs per day (a long label)', usedPercent: 0, resetsAt },
          ],
          status: null,
          at: Date.now(),
        },
      },
    },
  },
});

test('the usage-limit bars in the context popover line up whatever the labels and percentages say', async ({ page, harness }, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  const snapshot = withClaudeBreakdown(
    emptySnapshot('', Date.now()),
    {
      totalTokens: 60000,
      maxTokens: 200000,
      categories: [
        { name: 'System prompt', tokens: 10000, kind: 'used' },
        { name: 'Messages', tokens: 50000, kind: 'used' },
      ],
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167000,
    },
    Date.now(),
  );
  // The real IPC boundary answers every chat with this reading, so the ring and popover render without a model turn.
  await harness.app.evaluate(({ ipcMain }, value) => {
    for (const channel of ['context:get', 'context:refresh']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, owner) => ({
        ...value,
        owner: String(owner),
      }));
    }
  }, snapshot);
  await page.getByRole('complementary').getByText('Limit bars check', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await page.locator('.context-ring').click();
  const popover = page.locator('.ctx-popover');
  await expect(popover.locator('.ctx-summary-value')).toHaveText('30% used');
  await expect(page.locator('.composer-right .context-ring, .composer-right .usage-chip')).toHaveCount(1);
  await expect(popover.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '30');
  const fable = popover.locator('.limit-row', { hasText: 'Weekly · Fable' });
  await expect(fable.getByRole('meter')).toHaveAttribute('aria-valuenow', '5');
  await expect(fable.locator('.limit-row-reset')).toContainText('Resets in');
  await expect(popover.locator('.limit-row', { hasText: 'Routine runs per day' })).toHaveCount(1);
  expect(await popover.locator('.limit-row').count()).toBeGreaterThanOrEqual(3);
  const boxes = await popover.locator('.limit-row-bar').evaluateAll((bars) =>
    bars.map((bar) => {
      const r = bar.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  await info.attach('context-popover-limit-bars', {
    body: await popover.screenshot(),
    contentType: 'image/png',
  });
  info.annotations.push({
    type: 'bar boxes',
    description: JSON.stringify(boxes),
  });
  for (const box of boxes) {
    expect(Math.abs(box.left - boxes[0].left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.right - boxes[0].right)).toBeLessThanOrEqual(0.5);
  }
});

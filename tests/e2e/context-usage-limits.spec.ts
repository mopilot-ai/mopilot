// A newer CLI lists the extra-usage window beside the plan windows: the context card's Usage limits show the plan windows by
// name and never the raw `seven_day_overage_included` row.
// e2e-covers: src/components/panels/SummaryContext.tsx src/styles/app/summary-panel.css
import path from 'node:path';
import fs from 'node:fs';
import { test, expect, type Dirs } from './fixtures/app';

const SESSION = '6f4e0b9d-2c3a-4d7e-8f1b-1a2b3c4d5e6f';
test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: [{ id: SESSION, cwd: 'old-project', title: 'Usage limits check', turns: ['an old message'] }],
    uiState: { summaryOpen: true },
    files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-usage-windows'), ''),
  },
});

test('the usage limits list the plan windows by name and hide the extra-usage window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.getByRole('complementary').getByText('Usage limits check', { exact: true }).first().click();
  await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-claude: hello', { exact: true })).toBeVisible();
  const card = page.locator('.summary-context');
  await card.locator('summary').click();
  const limits = card.getByRole('region', { name: 'Usage limits' });
  await expect(limits).toContainText('5h');
  await expect(limits).toContainText('Weekly');
  await expect(limits).not.toContainText('overage');
});

test.describe('a reading saved before extra usage was left out', () => {
  test.use({
    seed: {
      claudeSessions: [{ id: SESSION, cwd: 'old-project', title: 'Usage limits check', turns: ['an old message'] }],
      uiState: {
        summaryOpen: true,
        claudeUsage: {
          default: {
            windows: [
              { label: 'Weekly', usedPercent: 50, resetsAt: null },
              { label: 'seven_day_overage_included', usedPercent: 2, resetsAt: null },
            ],
            status: null,
            at: Date.now(),
          },
        },
      },
    },
  });

  test('never shows the saved extra-usage row', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await page.getByRole('complementary').getByText('Usage limits check', { exact: true }).first().click();
    await expect(page.getByRole('main').getByText('fake-claude: an old message', { exact: true })).toBeVisible();
    const card = page.locator('.summary-context');
    await card.locator('summary').click();
    const limits = card.getByRole('region', { name: 'Usage limits' });
    await expect(limits).toContainText('Weekly');
    await expect(limits).not.toContainText('overage');
  });
});

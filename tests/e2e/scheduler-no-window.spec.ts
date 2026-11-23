// The scheduler and the run itself live in main (WP7-18, A15): with every window closed a due task still
// starts and runs, on Codex or on Claude Code, and the app opens no window for it. Main's scheduler
// clock is moved on instead of waiting for its tick.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';

const task = (harness: 'codex' | 'claude') =>
  [
    'version = 1',
    'id = "quiet-check"',
    'kind = "cron"',
    'name = "Quiet check"',
    "prompt = 'summarize the repo'",
    'status = "ACTIVE"',
    'rrule = "FREQ=MINUTELY;INTERVAL=1"',
    `harness = "${harness}"`,
    `updated_at = ${Date.now()}`,
    '',
  ].join('\n');

const seed = (harness: 'codex' | 'claude') => ({
  uiState: { prefs: { runSchedules: true } },
  files: ({ codexHome }: { codexHome: string }) => {
    const dir = path.join(codexHome, 'automations', 'quiet-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'automation.toml'), task(harness));
  },
});

/** Move the scheduler's clock on until a tick has found the task due and done `started`. */
const tickUntil = (harness: Harness, started: () => boolean) =>
  expect
    .poll(
      async () => {
        if (started()) return true;
        await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(61_000));
        return false;
      },
      { intervals: [3000], timeout: 50_000 },
    )
    .toBe(true);

async function noWindows(harness: Harness) {
  await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).then((n) => expect(n).toBe(0));
}

test.describe('Codex', () => {
  test.use({ harnesses: 'both', seed: seed('codex') });

  test('a due Codex task starts with no window open, and opens none', async ({ page, harness }) => {
    test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await page.close();
    await expect.poll(() => harness.app.windows().length).toBe(0);
    await tickUntil(harness, () =>
      harness.codexLog().some((l) => l.method === 'turn/start' && JSON.stringify(l.params).includes('summarize the repo')),
    );
    await noWindows(harness);
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'both', seed: seed('claude') });

  test('a due Claude Code task runs to its answer with no window open, and opens none', async ({ page, harness }) => {
    test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await page.close();
    await expect.poll(() => harness.app.windows().length).toBe(0);
    const prompted = () => harness.claudeLog().some((l) => l.kind === 'in' && JSON.stringify(l.msg).includes('summarize the repo'));
    await tickUntil(harness, prompted);
    await noWindows(harness);
    // the run's chat is on disk: the window that opens next lists it, with the answer nobody watched arrive
    await harness.app.evaluate(({ app }) => app.emit('activate'));
    const page2 = harness.app.windows()[0] ?? (await harness.app.waitForEvent('window'));
    const row = page2
      .getByRole('complementary')
      .getByText(/summarize the repo|Fake chat title/)
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page2.getByRole('main').getByText('fake-claude: summarize the repo', { exact: true })).toBeVisible();
  });
});

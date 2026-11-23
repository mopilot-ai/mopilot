// MoMo's morning brief (A7), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1) with `momo.brief` and `momo.tasksPanel` on and no quiet hours: the brief is a row in Tasks › Scheduled with its next time; with something waiting for the user (an approval card) and the user having been here, the scheduler's daily run (its clock moved on by the test) writes the brief into MoMo's chat as MoMo's own lines, a greeting and the one attention item, and it goes once (the lines do not repeat on the next days). The words come from a data-only chat the fake does not answer in JSON, so the fixed words show. Suggestion cards need yesterday's suggestions and are covered by the unit tests and the dev host.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChatSession, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1', MOPILOT_SCHEDULER_TEST: '1' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { tasksPanel: true, brief: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

test('the brief is a Scheduled row with its next time, and once something waits for the user it lands in MoMo’s chat once, with a greeting and the attention item', async ({
  page,
  harness,
}) => {
  test.setTimeout(240_000);
  await openMomo(page);
  const { chat, send } = await momoChatSession(page);
  await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });
  // something waits for the user: an approval card (and the user has been here: this message is their day of activity)
  await send('CUCALL momo_debug_action {"text":"one"}');
  const waiting = chat.locator('[data-kind="momoAction"]');
  await expect(waiting).toBeVisible({ timeout: 20_000 });

  // Tasks › Scheduled: the brief, with its next time and nothing to retry
  await goToMomoView(page, 'Tasks');
  await page
    .getByRole('tablist', { name: 'Tasks' })
    .getByRole('tab', { name: /^Scheduled/ })
    .click();
  const row = page.locator('[data-task="brief:morning"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('Morning brief');
  await expect(row).toContainText(/Next /);
  await expect(row.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('momo-brief-scheduled.png') });

  // the daily run, its clock moved on hour by hour: the brief lands in MoMo's chat as MoMo's lines
  await goToMomoView(page, 'Chat');
  const lines = chat.locator('.momo-brief');
  await expect
    .poll(
      async () => {
        await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(3_600_000));
        return lines.count();
      },
      { timeout: 150_000, intervals: [3_000] },
    )
    .toBeGreaterThan(1);
  await expect(lines.first()).toContainText(/^Good morning, /);
  // MoMo's, never the user's: no user message carries the greeting
  await expect(chat.locator('.user-message, [data-role="user"]').filter({ hasText: 'Good morning' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('momo-brief-chat.png') });

  // never twice a day: more days of clock do not repeat today's greeting before a day has passed (one brief per day)
  const first = await lines.count();
  await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(3_600_000));
  await expect.poll(() => lines.count(), { timeout: 10_000, intervals: [1_000] }).toBe(first);
});

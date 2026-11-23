// A Codex hook run that failed stays in its chat after a reload, including a SessionStart failure with no turn (#2066).
import { test, expect } from './fixtures/app';
import { HOOK_EARLY_FAILURE, HOOK_FAILURE } from './fixtures/fake-turn-details.mjs';

test.use({ harnesses: 'codex' });

test("failed hook lines survive a reload: the turn's own and one sent with no turn", async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('HOOKEARLY HOOKFAIL then answer');
  await composer.press('Enter');
  const main = page.getByRole('main');
  await expect(main.getByText('fake-codex: HOOKEARLY HOOKFAIL then answer', { exact: true })).toBeVisible();
  // the turn ends after its Stop hook ran
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  // soft: a run without the fix reports every missing line, live and after the reload
  await expect.soft(main.getByText(HOOK_FAILURE, { exact: true })).toBeVisible();
  await expect.soft(main.getByText(HOOK_EARLY_FAILURE, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('live.png') });

  // a reload drops the window's live turns: the chat is read back from Codex's thread/read, which has no hook runs
  await page.reload();
  await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).first().click();
  await expect(main.getByText('fake-codex: HOOKEARLY HOOKFAIL then answer', { exact: true })).toBeVisible();
  await expect.soft(main.getByText(HOOK_FAILURE, { exact: true })).toHaveCount(1);
  await expect.soft(main.getByText(HOOK_EARLY_FAILURE, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('reloaded.png') });
});

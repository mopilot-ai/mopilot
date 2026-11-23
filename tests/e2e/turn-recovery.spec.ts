// The original quiet-turn repro and terminal failure recovery in the real app, using only the scripted Codex fixture.
import { test, expect } from './fixtures/app';

test.use({ seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

test('a quiet turn stays working past one minute at narrow width and large font; composer Stop still works', async ({ page }, info) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('QUIETTURN quiet recovery repro');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(page.locator('.summary-slot')).toBeVisible();
  await expect
    .poll(() => page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('24px');
  await page.clock.setFixedTime(new Date(Date.now() + 90_000));
  await expect(page.locator('.claude-activity-time').last()).toContainText(/1m|1 min/);
  await expect(page.locator('.turn-stall')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep waiting', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(stop).toBeVisible();
  await page.screenshot({ path: info.outputPath('quiet-turn.png') });
  await stop.click();
  await expect(stop).toHaveCount(0);
});

test('only terminal failure offers Retry; it sends once and preserves finished work', async ({ page, harness }, info) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('PROVIDERFAIL run the tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const error = page.locator('.turn-error');
  await expect(error).toContainText('The provider could not finish the response.');
  await expect(page.locator('.turn-stall')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('failed-turn.png') });
  await error.getByRole('button', { name: 'Retry', exact: true }).dblclick();
  await expect(
    page.getByRole('main').getByText('fake-codex: PROVIDERFAIL run the tests [lint already ran]', { exact: true }),
  ).toBeVisible();
  await expect(error.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  const sends = harness
    .codexLog()
    .filter((entry) => entry.method === 'turn/start' && entry.params.input?.[0]?.text === 'PROVIDERFAIL run the tests');
  expect(sends).toHaveLength(2);
  expect(harness.codexLog().filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(0);
  expect(harness.codexLog().filter((entry) => entry.method === 'fake/command')).toHaveLength(1);
});

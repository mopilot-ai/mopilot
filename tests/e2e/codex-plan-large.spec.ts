// Oversized Codex planning turns retain their exact plan identity when the user chooses implementation.
import { test, expect } from './fixtures/app';

test.use({ harnesses: 'codex', seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });

for (const nativePlan of [false, true]) {
  test(`implement a large Codex ${nativePlan ? 'native' : 'plain-message'} plan`, async ({ page, harness }) => {
    // typing 43 KB into the composer takes 25 s on a quiet runner and over the 30 s action default late in a busy shard
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('/plan');
    await composer.press('Enter');
    await expect(page.locator('.plan-chip')).toBeVisible();
    const request = `${nativePlan ? 'PLANITEM ' : ''}add a button\n${'Preserve this detailed requirement.\n'.repeat(1200)}End of requirements.`;
    // over the 32 KB reference budget (peerTranscript.cjs), so the turn is oversized; filling it is one long action
    await composer.fill(request, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const plan = page.locator('.plan-card');
    await expect(plan).toContainText('End of requirements.');
    await plan.getByRole('button', { name: 'Implement this plan' }).click();
    await expect(page.getByRole('main').getByText('fake-codex: Implement the plan.', { exact: true })).toBeVisible();
    await expect(page.locator('.plan-chip')).toHaveCount(0);
    const implement = harness.codexLog().filter((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === 'Implement the plan.');
    expect(implement).toHaveLength(1);
    expect(implement[0].params.collaborationMode.mode).toBe('default');
    await page.screenshot({ path: test.info().outputPath(`large-${nativePlan ? 'native' : 'message'}-plan-implemented.png`) });
  });
}

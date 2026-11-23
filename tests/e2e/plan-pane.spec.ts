// Plan-pane journey on both harnesses: empty state, pending proposal, repeated comments, retained drafts and explicit approval.
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/SummaryActivity.tsx src/components/panels/PlanPanel.tsx
import { test, expect } from './fixtures/app';
import { shootBoth, SYSTEM_THEME } from './fixtures/shoot';

for (const harnesses of ['codex', 'claude'] as const) {
  test.describe(`Plan pane on ${harnesses}`, () => {
    test.use({ harnesses, seed: { uiState: { summaryOpen: true, prefs: SYSTEM_THEME.prefs } } });
    test('reads proposals and retains line comments without approving the plan', async ({ page, harness }) => {
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('warm up');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`fake-${harnesses}: warm up`, { exact: true })).toBeVisible();
      const summary = page.locator('.summary-panel');
      await expect(summary.locator('.summary-plan')).toHaveCount(0);
      await summary.getByRole('button', { name: 'Session actions' }).click();
      await page.getByRole('menuitem', { name: 'View plan', exact: true }).click();
      await expect(page.locator('.plan-pane')).toContainText('No plan has been proposed');
      await page.getByRole('button', { name: 'Close Plan tab', exact: true }).click();
      await page.getByRole('button', { name: 'Add files and more' }).click();
      await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
      await composer.fill('PLAN PLANITEM propose a small change');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const card = page.getByRole('main').locator('.plan-card');
      await expect(card).toContainText('propose a small change');
      await summary.locator('button.summary-plan').click();
      const pane = page.locator('.plan-pane');
      await expect(pane).toContainText('propose a small change');
      await pane.getByRole('button', { name: 'Comment on lines', exact: true }).click();
      await pane.getByRole('button', { name: 'Comment on plan line 1', exact: true }).click();
      const comment = pane.getByRole('textbox', { name: 'Annotation comment' });
      await comment.fill('Keep the first step small');
      await comment.press('Enter');
      await expect(comment).toHaveCount(0);
      await pane.getByRole('button', { name: 'Comment on plan line 2', exact: true }).click();
      await comment.fill('Add focused tests');
      // Closing the pane before Done must retain every keystroke in the originating draft.
      await page.getByRole('button', { name: 'Close Plan tab', exact: true }).click();
      if (harnesses === 'claude') {
        const approve = page.getByRole('button', { name: /^Approve plan/ });
        await expect(approve).toBeVisible();
        expect(harness.claudeLog().filter((event: any) => event.kind === 'plan')).toHaveLength(0);
        await approve.click();
        await expect(page.getByRole('main').getByText(/plan approved, now/)).toBeVisible();
      } else {
        await expect(card.getByRole('button', { name: 'Implement this plan', exact: true })).toBeVisible();
        expect(
          harness.codexLog().filter((event) => event.method === 'turn/start' && event.params.input?.[0]?.text === 'Implement the plan.'),
        ).toHaveLength(0);
      }
      await page.getByRole('button', { name: 'View 2 annotations', exact: true }).click();
      await expect(page.locator('.selection-pop')).toContainText('Keep the first step small');
      await expect(page.locator('.selection-pop')).toContainText('Add focused tests');
      await page.keyboard.press('Escape');
      await card.getByRole('button', { name: 'Open plan', exact: true }).click();
      await expect(pane).toContainText('propose a small change');
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 682 });
        await shootBoth(page, harness.app, `plan-pane-${width}`);
      }
    });
  });
}

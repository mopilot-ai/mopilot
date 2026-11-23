// MoMo's approval card (#2139), on fake harnesses only: an invited account's MoMo chat calls momo_debug_action (a change of
// a test source set to ask, through MoMo's trust gate: electron/momo/debugAction.cjs, registered with SAGE_DEBUG_TOOLS=1);
// the momoAction card shows in MoMo's Chat with the question, why and the exact detail; Allow once runs it; the same
// change asks again, and Allow for this chat runs it and the next one without a card; Deny tells the model not to retry.
import { test, expect } from './fixtures/app';
import { momoSeed, openMomoChat } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('the card asks before the change; Allow once runs it; Allow for this chat is not asked again; Deny refuses', async ({ page }) => {
      const { chat, send } = await openMomoChat(page);
      const card = chat.locator('[data-kind="momoAction"]');

      await send('CUCALL momo_debug_action {"text":"one"}');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByRole('heading')).toHaveText('Allow MoMo to change Test notes?');
      await expect(card).toContainText('Test notes is set to ask before changes.');
      await expect(card).toContainText('Write “one” to the test notes');
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect(card).toHaveCount(0);
      await expect(chat.getByText(/Saved\. Wrote: one/)).toBeVisible({ timeout: 20_000 });

      // once kept nothing: the same change asks again; for this chat, the next one runs without a card
      await send('CUCALL momo_debug_action {"text":"one"}');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByRole('button', { name: 'Allow for this chat', exact: true }).click();
      await expect(chat.getByText(/Saved\. Wrote: one/)).toHaveCount(2, { timeout: 20_000 });
      await send('CUCALL momo_debug_action {"text":"one"}');
      await expect(chat.getByText(/Saved\. Wrote: one/)).toHaveCount(3, { timeout: 20_000 });
      await expect(card).toHaveCount(0);

      // a different change asks; Deny tells the model not to retry
      await send('CUCALL momo_debug_action {"text":"two"}');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(chat.getByText(/The user declined this, so nothing was sent\. Don't retry it/)).toBeVisible({ timeout: 20_000 });
    });
  });
}

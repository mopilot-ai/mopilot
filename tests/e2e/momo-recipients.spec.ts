// MoMo's approval card names every recipient (#4649 A4), on fake harnesses only: an invited account's MoMo chat calls momo_debug_action
// as a send (electron/momo/debugAction.cjs, SAGE_DEBUG_TOOLS=1) to several recipients; the momoAction card shows each one and the
// total; Allow once runs it. A send that names nobody, or none MoMo can read, shows a card that says why and offers only Dismiss, and
// nothing is written.
import { test, expect } from './fixtures/app';
import { momoSeed, openMomoChat } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('a send lists every recipient; one with no readable recipient is blocked with its reason', async ({ page }) => {
      const { chat, send } = await openMomoChat(page);
      const card = chat.locator('[data-kind="momoAction"]');

      await send('CUCALL momo_debug_action {"text":"hi","send":true,"to":["ann@example.com","bo@example.com","cy@example.com"]}');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByRole('heading')).toHaveText('Allow MoMo to send to ann@example.com and 2 more?');
      await expect(card).toContainText('To · 3');
      await expect(card).toContainText('ann@example.com, bo@example.com, cy@example.com');
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect(chat.getByText(/Saved\. Wrote: hi/)).toBeVisible({ timeout: 20_000 });

      // a send that names nobody: the card says why, has no allow, and Dismiss refuses it
      await send('CUCALL momo_debug_action {"text":"two","send":true}');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByRole('heading')).toHaveText("MoMo can't tell who this reaches");
      await expect(card).toContainText("This reaches people but names none, so MoMo can't allow it.");
      await expect(card.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
      await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(chat.getByText(/names none, so nothing was sent/)).toBeVisible({ timeout: 20_000 });
      await expect(chat.getByText(/Saved\. Wrote: two/)).toHaveCount(0);
    });
  });
}

// MoMo's "/" menu is Feedback alone (shared/momoCommands.mjs), on fake harnesses only: "/" in MoMo's chat lists
// Feedback and none of the coding commands (Chat, Plan mode, Model, Work in a project...), Feedback opens the bug
// report, and a typed /new, /plan, /model or /clear goes to MoMo as plain text: MoMo answers it, the chat stays MoMo's,
// no plan chip appears, and Claude Code's CLI runs none of them as its own command.
import { test, expect } from './fixtures/app';
import { momoChat, momoReply, momoSeed, openMomo } from './fixtures/momo';

for (const [harnesses, reply] of [
  ['claude', 'fake-claude'],
  ['codex', 'fake-codex'],
] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('"/" lists Feedback alone, and a typed /new, /plan, /model or /clear reaches MoMo as text', async ({ page, harness }) => {
      await openMomo(page);
      const chat = momoChat(page);
      const box = chat.getByRole('textbox', { name: 'Message', exact: true });
      await expect(box).toBeVisible({ timeout: 15_000 });

      await box.fill('/');
      const titles = page.locator('.slash-panel .add-panel-title');
      await expect(titles).toHaveText(['Feedback']);
      await page.locator('.slash-panel .add-panel-item', { hasText: 'Feedback' }).click();
      // the app's Modal (a titled .dialog box); Escape closes it
      const report = page.locator('.dialog', { has: page.locator('.dialog-head', { hasText: 'Report a bug' }) });
      await expect(report).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(report).toHaveCount(0);

      for (const typed of ['/new', '/plan', '/model', '/clear']) {
        await box.fill(typed);
        await expect(page.locator('.slash-panel .add-panel-item')).toHaveCount(0);
        await box.press('Enter');
        await expect(chat.getByText(momoReply(reply, typed)).last()).toBeVisible({ timeout: 20_000 });
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });
        // still MoMo's chat: /new opened no new chat, /plan turned no plan mode on, /model opened no picker
        await expect(box).toHaveAttribute('data-placeholder', 'Message MoMo');
        await expect(chat.locator('.plan-chip')).toHaveCount(0);
        await expect(page.locator('.hp-models')).toHaveCount(0);
      }
      // Claude Code would run "/clear" as its own command (the fake CLI does as CLI 2.1.311 does: a message that starts
      // with "/", untrimmed): MoMo's text reached it as plain text, so the CLI ran no command and the model answered it
      if (harnesses === 'claude') expect((harness.claudeLog() as any[]).filter((e) => e.kind === 'local')).toEqual([]);
    });
  });
}

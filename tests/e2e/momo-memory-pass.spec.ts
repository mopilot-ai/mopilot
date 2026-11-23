// MoMo's background memory pass reads what the user said (#2139 P3), on the fake harnesses for an invited account
// (MOPILOT_MOMO_DEV=1), on Claude Code (whose turns carry MoMo's block ahead of the user's words) and on Codex: the user
// tells MoMo something; once the chat is quiet the pass (a data-only background chat the fake answers with the user's
// lines as facts) keeps it, and Memory › Facts shows it. Before the fix the pass never saw the user's words (it read a
// field transcript items don't carry), so the fact, made of words nobody said in its prompt, was dropped.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChatSession, openMomo, settingsGroup } from './fixtures/momo';

function journey(harnesses: 'claude' | 'codex') {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000' }, seed: { files: (d) => codexCliLogin(d) } });

    test('what the user told MoMo becomes a fact once the chat is quiet', async ({ page }) => {
      test.setTimeout(180_000);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      // the fake says "Noted." instead of echoing, so the words are in the user's message alone
      await send('NOECHO I moved to Lisbon last month');
      await expect(chat.getByText('Noted.', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      await goToMomoView(page, 'Memory');
      const fact = settingsGroup(page, 'Facts').getByText('I moved to Lisbon last month', { exact: true });
      await expect(fact).toBeVisible({ timeout: 90_000 });
      await page.screenshot({ path: test.info().outputPath(`momo-memory-pass-${harnesses}.png`) });
    });
  });
}

journey('claude');
journey('codex');

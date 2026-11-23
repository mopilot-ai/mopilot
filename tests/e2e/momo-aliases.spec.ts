// MoMo finds an earlier turn by words it never used (#2999 P2), on fake harnesses for an invited account
// (MOPILOT_MOMO_DEV=1), on Claude Code and on Codex: the user tells MoMo something in English, the turn goes into MoMo's
// index of its past chats, MoMo's background search aliases (electron/momo/historyAliases.cjs, in a data-only background
// chat on the same harness: the fake answers the aliases prompt with each turn's other-language words) add its Chinese
// words, and a later momo_history_search in Chinese, which shares no word with the turn, finds it.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChatSession, momoReply, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

function journey(harnesses: 'claude' | 'codex') {
  const fake = harnesses === 'claude' ? 'fake-claude' : 'fake-codex';
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_ALIAS_TICK_MS: '2000' },
      seed: { files: (d) => codexCliLogin(d) },
    });

    test('a Chinese question that shares no word with an English turn finds it through its aliases', async ({ page }) => {
      test.setTimeout(240_000);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      await expect(chat.getByText(new RegExp(`${fake}: `)).first()).toBeVisible({ timeout: 30_000 });

      const said = 'My dentist appointment is next Wednesday afternoon';
      await send(said);
      await expect(chat.getByText(momoReply(fake, said))).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

      // each answer that found the turn is one result block naming it; a later search must add one more
      const found = async () =>
        ((await chat.innerText()) ?? '').match(
          /snippets? from MoMo's past chats[\s\S]{0,600}?\d{4}-\d{2}-\d{2}, MoMo chat [\s\S]{0,200}?User: My dentist appointment is next Wednesday afternoon/g,
        )?.length ?? 0;
      const search = async (query: string) => {
        const before = await found();
        await expect
          .poll(
            async () => {
              await send(`CUCALL momo_history_search ${JSON.stringify({ query })}`);
              await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
              return found();
            },
            { timeout: 150_000, intervals: [5_000] },
          )
          .toBeGreaterThan(before);
      };
      // "牙医" (dentist) is in no word the user wrote: only the aliases written in the background match it
      await search('牙医是哪天');
      // the aliases' background chat stays out of sight: no chat in the sidebar shows the aliases prompt
      await expect(page.getByText('For each numbered chat turn below')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`momo-aliases-${harnesses}.png`) });
    });
  });
}

journey('claude');
journey('codex');

// MoMo finds what was said in an earlier turn of its chats (#2999 P1), on fake harnesses for an invited account (MOPILOT_MOMO_DEV=1),
// on Claude Code and on Codex: the user tells MoMo something, the finished turn goes into MoMo's index of its past chats
// (electron/app/momoHistory.cjs), and a later turn's momo_history_search (the fake harness calls the tool) answers with that turn,
// dated, in the user's own words, including a Chinese question that shares only part of it.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChatSession, momoReply, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

function journey(harnesses: 'claude' | 'codex') {
  const fake = harnesses === 'claude' ? 'fake-claude' : 'fake-codex';
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, seed: { files: (d) => codexCliLogin(d) } });

    test('what the user said in an earlier turn is found by a later search, in English and by part of a Chinese sentence', async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      await expect(chat.getByText(new RegExp(`${fake}: `)).first()).toBeVisible({ timeout: 30_000 });

      await send('My lease ends in December. 房东说月底前要续约');
      await expect(chat.getByText(momoReply(fake, 'My lease ends in December. 房东说月底前要续约'))).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

      // the finished turn reaches the index in the background: a search may need a moment to find it
      // each answer that found the turn is one result block naming it; a later search must add one more
      const found = async () =>
        ((await chat.innerText()) ?? '').match(
          /snippets? from MoMo's past chats[\s\S]{0,600}?\d{4}-\d{2}-\d{2}, MoMo chat [\s\S]{0,200}?User: My lease ends in December\. 房东说月底前要续约/g,
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
            { timeout: 90_000, intervals: [3_000] },
          )
          .toBeGreaterThan(before);
      };
      await search('when does the lease end');
      // a Chinese question that shares only part of the sentence (two-character pairs)
      await search('续约的事');
      await page.screenshot({ path: test.info().outputPath(`momo-history-${harnesses}.png`) });
    });
  });
}

journey('claude');
journey('codex');

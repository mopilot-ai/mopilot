// "Always allow <host>" on MoMo's open card (#3655), on fake harnesses only: after a page read (private data) MoMo's chat
// opens a new site with a query: the momoAction card asks to open it with Allow once only and says why; with a clean address
// it offers Always allow for that host, and choosing it lets the call through (the in-app browser's own site card is next), and a click on that page then runs with no MoMo card, as after Allow once;
// Settings › MoMo lists the site, and Remove takes it off. That a chat other than the one that chose it opens the site with no
// card is covered at the gate (tests/momoToolTrustSites.test.ts): the fakes have no second MoMo chat to drive.
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { goToMomoSettings, momoSeed, openMomoChat, settingsGroup } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const HOST = 'example.com';

for (const harnesses of ['claude', 'codex'] as const) {
  // Claude reaches the in-app browser's tools on their own MCP server; Codex calls them by name
  const tool = (name: string) => (harnesses === 'claude' ? `mcp__mopilot_browser__${name}` : `browser_${name}`);
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, ...momoSeed(harnesses) });

    test('after a page read, a query asks once only; Always allow on a clean open keeps the site; Settings lists it and Remove takes it off', async ({
      page,
    }) => {
      const { chat, send } = await openMomoChat(page);
      const card = chat.locator('[data-kind="momoAction"]');

      // a page read taints the chat; opening a new site with an address that may carry data asks, with Allow once only
      await send([`CUCALL ${tool('get_page_text')} {}`, `CUCALL ${tool('navigate')} {"url":"https://${HOST}/?q=kiwi"}`].join('\n'));
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('heading')).toHaveText(`Allow MoMo to open ${HOST}?`);
      await expect(card).toContainText('This chat read your private data, and this address may carry some.');
      await expect(card.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: `Always allow ${HOST}`, exact: true })).toHaveCount(0);
      await card.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(card).toHaveCount(0);

      // the same site with a clean address offers Always allow for that host; a click on the page follows in the same turn
      const results = async () => ((await chat.textContent()) ?? '').match(/\[cu: /g)?.length ?? 0;
      const before = await results();
      await send(
        [
          `CUCALL ${tool('navigate')} {"url":"https://${HOST}/"}`,
          `CUCALL ${tool('computer')} {"action":"left_click","coordinate":[20,20]}`,
        ].join('\n'),
      );
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('This chat read your private data, and this site is new to it.');
      await card.getByRole('button', { name: `Always allow ${HOST}`, exact: true }).click();
      await expect(card).toHaveCount(0);
      // past MoMo's gate: the in-app browser asks for the site itself
      const siteCard = chat.locator('.sage-approval');
      await expect(siteCard).toContainText(`use https://${HOST}`, { timeout: 30_000 });
      await pickScope(siteCard, /Allow in this chat/);
      await expect(siteCard).toHaveCount(0);
      // the open counts as opened for the chat, as after Allow once: the click runs with no MoMo card
      await expect.poll(results, { timeout: 60_000 }).toBeGreaterThanOrEqual(before + 2);
      await expect(card).toHaveCount(0);

      // Settings › MoMo lists the site; Remove takes it off
      await goToMomoSettings(page, 'Brain');
      const sites = settingsGroup(page, 'Sites MoMo may open');
      await expect(sites).toContainText(HOST);
      await page.screenshot({ path: test.info().outputPath('settings-momo-sites.png') });
      await sites.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(sites).toHaveCount(0);
    });
  });
}

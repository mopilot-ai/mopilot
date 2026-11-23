// The app's own access cards in MoMo's chat (#2313), on fake harnesses only: a MoMo chat's computer-use call asks on the
// computer access card and its in-app browser call on the site card, in MoMo's Chat as in a coding chat; the answer
// reaches the tool, which runs (against the fake helper / a local page).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { openMomoChat } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.describe('computer use in MoMo', () => {
  test.use({ harnesses: 'claude', computerHelper: true, env: { MOPILOT_MOMO_DEV: '1' }, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('a click asks on the computer access card in MoMo’s chat; Allow once runs it', async ({ page, harness }) => {
    const { chat, send } = await openMomoChat(page);
    await send('CUCALL computer_click {"x":10,"y":20}');
    const card = chat.locator('.sage-approval');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('control Notes');
    await pickScope(card, /Allow once/);
    await expect(chat.getByText(/\[cu: Done: click in Notes\./)).toBeVisible({ timeout: 20_000 });
    expect(harness.helper!.log.filter((m) => m.method === 'input.click')).toHaveLength(1);
  });
});

test.describe('the in-app browser in MoMo', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });
  let server: http.Server;
  let port = 0;
  test.beforeAll(async () => {
    server = http.createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Momo fixture</title><p>kiwi-7</p>'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  test.afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test('a new site asks on the site card in MoMo’s chat; Allow in this chat opens and reads it', async ({ page }) => {
    const { chat, send } = await openMomoChat(page);
    const site = `http://127.0.0.1:${port}`;
    await send([`CUCALL mcp__mopilot_browser__navigate {"url":"${site}/"}`, 'CUCALL mcp__mopilot_browser__get_page_text {}'].join('\n'));
    const card = chat.locator('.sage-approval');
    await expect(card).toContainText(`use ${site}`, { timeout: 20_000 });
    await pickScope(card, /Allow in this chat/);
    await expect(chat.getByText(/kiwi-7/)).toBeVisible({ timeout: 30_000 });
  });
});

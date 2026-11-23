// CUJ chrome-panel-limit on Claude Code, Codex and a basic (ACP) harness, with Google Chrome and MoPilot's real extension (#3046): a turn that stops because
// the account is out of usage says so in the side panel, in the rows and in the usage banner above the composer ("limit reached", with its window and reset time
// when the harness says them). It used to leave the panel on a green "Done" with no message at all (the limit note was left out of the panel's rows), and the
// banner never showed: the panel read a `limit` field main did not send.
//
// The limits are MOCKED by the fake harnesses: the only Claude login is out of usage (`.fake-limited`: every turn ends on a rejected five-hour rate limit, as the CLI
// reports it); "USAGELIMIT" in a message ends a fake Codex turn on codexErrorInfo usageLimitExceeded (fixtures/fake-codex-accounts.mjs); "RATELIMITED" makes the fake
// ACP agent fail the prompt with "Rate limit exceeded" (tests/fixtures/fake-acp-agent.mjs). From there it is real: main reads each harness's own words.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Dirs } from './fixtures/app';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Fee page</title><h1>Pay the fee</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 300_000 });
for (const kind of ['claude', 'codex', 'acp'] as const)
  test.describe(kind, () => {
    // Claude: the only login is out of usage, so every turn ends on a rejected rate limit
    test.use(
      kind === 'acp'
        ? { harnesses: 'claude', acp: { kimi: {} } }
        : kind === 'codex'
          ? { harnesses: 'codex' }
          : { harnesses: 'claude', seed: { files: (d: Dirs) => fs.writeFileSync(path.join(d.claudeHome, '.fake-limited'), '') } },
    );
    const harnessId = kind === 'acp' ? 'acp:kimi' : kind;
    const prompt =
      kind === 'codex'
        ? 'USAGELIMIT pay the fee on this page'
        : kind === 'acp'
          ? 'RATELIMITED pay the fee on this page'
          : 'Pay the fee on this page';

    test(`chrome-panel-limit on ${kind}: a turn stopped by the usage limit says so, in the usage banner too, and is not "Done"`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`[...document.getElementById('harness').options].map((o) => o.value)`)).toContain(harnessId);
      await side.inPanel(
        `(() => { const h = document.getElementById('harness'); h.value = ${JSON.stringify(harnessId)}; h.dispatchEvent(new Event('change')); })()`,
      );
      const send = () =>
        side.inPanel(`(() => {
          const text = document.getElementById('text'); text.value = ${JSON.stringify(prompt)}; text.dispatchEvent(new Event('input'));
          document.getElementById('composer').requestSubmit();
        })()`);
      const banner = () =>
        side.inPanel(
          `(() => { const u = document.getElementById('usage'); return u.hidden ? null : { text: document.getElementById('usage-text').textContent, kind: u.dataset.kind }; })()`,
        );
      await send();

      // the usage banner says the limit is reached: Claude names its window and reset, the others only that it is reached
      await expect.poll(banner, { timeout: 60_000 }).not.toBeNull();
      const shown = (await banner())!;
      expect(shown.kind).toBe('reached');
      if (kind === 'claude') expect(shown.text).toMatch(/^5-hour limit reached · resets \d{1,2}:\d{2}/);
      else expect(shown.text).toBe('Usage limit reached');
      // the composer stays open under it: the chat may go on another harness, or when the window resets
      expect(
        await side.inPanel(`(() => {
          const t = document.getElementById('text');
          t.value = 'a message typed under the banner'; t.dispatchEvent(new Event('input'));
          const open = !t.disabled && !document.getElementById('send').disabled;
          t.value = ''; t.dispatchEvent(new Event('input'));
          return open;
        })()`),
      ).toBe(true);
      if (kind === 'claude') {
        // the limit is on the panel, in the rows where the turn stopped, and the line under them says the same
        await expect
          .poll(() => side.inPanel(`[...document.querySelectorAll('#rows .note')].map(n => n.textContent)`), { timeout: 60_000 })
          .toContain('Claude AI usage limit reached');
        await expect
          .poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 30_000 })
          .toBe('Limit reached');
        expect(await side.inPanel(`document.getElementById('progress-dot').className`)).toBe('dot error');
      }
      await side.screenshot(info.outputPath('limit.png'));

      // the X dismisses it; the next message stops on the limit again, a new episode that shows it again
      await side.click('#usage-off');
      await expect.poll(banner).toBeNull();
      await send();
      await expect.poll(banner, { timeout: 60_000 }).not.toBeNull();
    });
  });

// CUJ chrome-windowless on Claude Code and Codex, with Google Chrome and MoPilot's real extension (#3714): Chrome keeps running with no
// window open (macOS after its last window closes; the bench Chrome's --no-startup-window), and a chat's first step in the user's Chrome
// still opens its page, in a new window of its own, instead of failing with "No current window".
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { pickScope } from './fixtures/approvalScope';
import type { Harness } from './fixtures/app';
import type { ExtensionChrome } from './fixtures/extensionChrome';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Vendor quote</title><h1>Request a quote</h1>'),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const chromeOn = (chrome: ExtensionChrome) => chrome.context.pages().some((p) => p.url().startsWith(site));

async function journey(
  page: Page,
  harness: Harness,
  launchChrome: () => Promise<ExtensionChrome>,
  call: (name: string, args: object) => string,
) {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const chrome = await launchChrome();
  let disconnectedAt: number | null = null;
  chrome.browser.once('disconnected', () => {
    disconnectedAt = Date.now();
  });
  await pairWithAllow(page, chrome);
  // the user closes Chrome's last window: Chrome keeps running, connected, with none open
  for (const p of chrome.context.pages()) await p.close();
  await expect.poll(() => chrome.context.pages().length, { timeout: 15_000 }).toBe(0);
  const windowless = { at: Date.now(), connected: chrome.browser.isConnected() };

  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const step = call('navigate', { url: site });
  await composer.fill(step);
  await expect(composer).toContainText(step);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.locator('.sage-approval');
  try {
    await expect
      .poll(async () => (chromeOn(chrome) ? 'open' : (await card.count()) ? 'ask' : 'waiting'), { timeout: 90_000 })
      .not.toBe('waiting');
  } catch (error) {
    // what the chat showed and what the harness saw, for the run's artifacts
    await test.info().attach('windowless-state.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        windowless,
        chromeConnected: chrome.browser.isConnected(),
        disconnectedAt,
        main: (await page.getByRole('main').innerText()).slice(-2500),
        cards: await card.allInnerTexts(),
        chromePages: chrome.context.pages().map((p) => p.url()),
        claude: harness.claudeLog().slice(-12),
        codex: harness.codexLog().slice(-12),
      }),
    });
    throw error;
  }
  if (!chromeOn(chrome)) await pickScope(card, /Allow in this chat/);
  // the page opens in Chrome, in a window the extension made for it, and the turn ends without the old failure
  await expect.poll(() => chromeOn(chrome), { timeout: 30_000 }).toBe(true);
  await expect(page.locator('button.send-btn.stop')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('main')).not.toContainText('No current window');
  const quote = chrome.context.pages().find((p) => p.url().startsWith(site))!;
  await expect(quote).toHaveTitle('Vendor quote');
}

test.describe.configure({ timeout: 180_000 });

// ACP sends the same chrome.tabs.create command through the same relay (chromeRelay.cjs createTab), covered by
// tests/chromeWindowlessTabs.test.ts.
test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude' });
  test('chrome-windowless on Claude Code: with no Chrome window open, the first step opens its page in a new window', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await journey(page, harness, launchChrome, (name, args) => `CUCALL mcp__mopilot_chrome__${name} ${JSON.stringify(args)}`);
  });
});

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  test('chrome-windowless on Codex: with no Chrome window open, the first step opens its page in a new window', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await journey(page, harness, launchChrome, (name, args) => `CUCALL chrome_${name} ${JSON.stringify(args)}`);
  });
});

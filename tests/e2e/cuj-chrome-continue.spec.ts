// CUJ chrome-continue on both harnesses, with Google Chrome and MoPilot's real extension against the app: Continue in Chrome on a built-in browser page first finds the extension missing and offers Add to Chrome; the user adds it, Chrome asks through the native host and the app's one Allow pairs it (no code), and the hand-off then goes ahead by itself: the page opens in that Chrome and the chat continues with "Continue in Chrome · <host>", its routing note hidden from the bubble.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import type { ExtensionChrome } from './fixtures/extensionChrome';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const agentBar = (page: Page) => page.locator('.browser-agent-bar');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Checkout</title><h1>Sign in to pay</h1>'),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Whether Chrome has a tab on the site (the extension's tab group or a window of its own). */
const chromeOn = (chrome: ExtensionChrome) => chrome.context.pages().some((p) => p.url().startsWith(site));

async function journey(
  page: Page,
  harness: Harness,
  launchChrome: () => Promise<ExtensionChrome>,
  who: string,
  tool: (s: string) => string,
) {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // 1. the agent opens a page in the built-in browser and hands it to the user (the tab stays in the pane)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const calls = [
    `CUCALL ${tool('navigate')} ${JSON.stringify({ url: `${site}/` })}`,
    `CUCALL ${tool('request_signin')} ${JSON.stringify({ reason: 'Sign in to pay' })}`,
  ];
  await composer.fill(calls.join('\n'));
  await expect(composer).toContainText(calls[1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(card(page)).toContainText(`Allow ${who} to use ${site}`);
  await pickScope(card(page), /Allow in this chat/);
  await expect(agentBar(page)).toHaveAttribute('data-state', 'handoff');
  await expect(page.locator('button.send-btn.stop')).toHaveCount(0);

  // 2. Continue in Chrome checks the extension first: it isn't in Chrome yet, so the pane offers to add it
  await page.getByRole('button', { name: 'Continue in Chrome', exact: true }).click();
  const notice = page.locator('.browser-handoff');
  await expect(notice).toContainText("Add MoPilot's extension to Chrome to continue there.", { timeout: 15_000 });
  await expect(notice.getByRole('button', { name: 'Add to Chrome' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Browser settings' })).toBeVisible();

  // 3. the user adds it: Chrome asks, the app's Allow pairs it, and the hand-off goes ahead by itself
  const chrome = await launchChrome();
  expect(chromeOn(chrome)).toBe(false);
  await pairWithAllow(page, chrome);
  await expect.poll(() => chromeOn(chrome), { timeout: 30_000 }).toBe(true);
  const host = new URL(site).host;
  await expect(transcript(page)).toContainText(`Continue in Chrome · ${host}`, { timeout: 30_000 });
  // the routing note reached the agent, not the bubble
  const bubble = transcript(page)
    .locator('.user-message')
    .filter({ hasText: `Continue in Chrome · ${host}` });
  await expect(bubble).toHaveCount(1);
  await expect(bubble).not.toContainText('sage-browser-handoff');
  await expect(bubble).not.toContainText('chrome_tabs_context_mcp');
  await expect
    .poll(() => JSON.stringify([harness.codexLog(), harness.claudeLog()]).includes('sage-browser-handoff'), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('button.send-btn.stop')).toHaveCount(0, { timeout: 30_000 });
}

test.describe.configure({ timeout: 180_000 });
// a Chrome the user has used, without MoPilot's extension: its profile says so (chromeProfileExtension.cjs)
test.use({ chromeUsedBefore: true });

test.describe('Codex', () => {
  test.use({ harnesses: 'codex' });
  test('chrome-continue on Codex: extension missing offers Add to Chrome; Allow pairs; the hand-off goes ahead in that Chrome', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await journey(page, harness, launchChrome, 'Codex', (s) => `browser_${s}`);
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude' });
  test('chrome-continue on Claude Code: extension missing offers Add to Chrome; Allow pairs; the hand-off goes ahead in that Chrome', async ({
    page,
    harness,
    launchChrome,
  }) => {
    await journey(page, harness, launchChrome, 'Claude Code', (s) => `mcp__mopilot_browser__${s}`);
  });
});

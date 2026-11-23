// CUJ use-my-chrome on both harnesses: Settings → Browser picks "Your Chrome" (the connection test says the
// Playwright Extension is missing, since the profile has no Chrome); a site visit asks on the site card and is then
// run through the Your Chrome channel (it reaches @playwright/mcp, not the built-in browser tab); back on the
// built-in browser the user separately grants the site read-only access; it asks again before a click: Read only refuses the
// click, until the user grants Read and write in Settings, and then the click goes through. Claude Code sessions
// start with --no-chrome so the CLI's own Chrome is never used.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, builtinBrowserPages, sendAppCommand, type Harness } from './fixtures/app';
import { BUILTIN, CHROME, WITHOUT_OWN_EXTENSION, choosePreferredBrowser, preferredBrowser } from './fixtures/preferredBrowser';
import { remoteFlags } from './fixtures/flags';
import { pickScope } from './fixtures/approvalScope';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await expect(composer).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** Several CUCALL lines, run in order in one turn: a tab the agent opens in the in-app browser closes when its turn ends. */
async function sendCalls(page: Page, calls: string[]) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(calls.join('\n'));
  await expect(composer).toContainText(calls[calls.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/**
 * An in-app browser tool by its short name, as each harness gets it (#351): Codex calls the Registry's browser_*
 * tools; Claude Code calls them on their own SDK server, mopilot_browser, under the short names (#350).
 */
const browserTool = (fake: string, short: string) => (fake === 'fake-claude' ? `mcp__mopilot_browser__${short}` : `browser_${short}`);
async function openBrowserSettings(h: Harness) {
  await sendAppCommand(h, 'settings');
  await h.page.locator('.side-row', { hasText: 'Browser' }).click();
}

// the link covers the page, so a click at any point follows it
const PAGE =
  '<!doctype html><title>Logged-in page</title><h1>Signed in as the user</h1><a href="/two" style="position:fixed;inset:0">Next</a>';
let server: http.Server;
let port = 0;
test.beforeAll(async () => {
  server = http.createServer((req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(req.url === '/two' ? '<!doctype html><title>Page two</title><h1>Second page</h1>' : PAGE),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function journey(page: Page, harness: Harness, who: string, fake: string) {
  await expect(home(page)).toBeVisible();
  await openBrowserSettings(harness);
  // 1. choose Your Chrome; the guide's link and the connection test (no Chrome in this profile)
  await choosePreferredBrowser(page, CHROME);
  await expect(preferredBrowser(page)).toHaveText(CHROME);
  const extension = page.locator('.settings-row').filter({ has: page.getByText('Playwright Extension', { exact: true }) });
  await expect(extension.getByRole('button', { name: 'Get the extension', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.settings-row', { hasText: 'Test connection' })).toContainText('Playwright Extension not found', {
    timeout: 30_000,
  });
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await expect(home(page)).toBeVisible();

  // 2. the agent opens a site: the site card comes first, then the call goes to Your Chrome (not a built-in tab)
  const site = `http://127.0.0.1:${port}`;
  await send(page, `CUCALL sage_browser_navigate {"url":"${site}/"}`);
  await expect(card(page)).toContainText(`Allow ${who} to use ${site}`);
  await pickScope(card(page), /Always allow/);
  await expect(transcript(page)).toContainText("Your Chrome isn't set up: the Playwright Extension isn't installed", { timeout: 30_000 });
  expect(await builtinBrowserPages(harness)).toBe(0);
  expect(await page.evaluate(() => (window as any).native.browser.sites('chrome'))).toEqual([{ origin: site, level: 'read' }]);
  expect(await page.evaluate(() => (window as any).native.browser.sites())).toEqual([]);

  // 3. back on the built-in browser, driven by the in-app browser tools (sage_browser_* serve only Your Chrome
  // since #351): grant it separately in Settings. The granted site opens without another card; a click needs write, and a local server saved
  // as read only asks again (origins.cjs peek 'reask'). Read only on that card refuses the click.
  await openBrowserSettings(harness);
  await choosePreferredBrowser(page, BUILTIN);
  await expect(preferredBrowser(page)).toHaveText(BUILTIN);
  const sites = page.getByRole('table', { name: 'Sites' });
  const level = sites.getByRole('combobox', { name: `Built-in browser for ${site}`, exact: true });
  await expect(level).toHaveValue('');
  await level.selectOption('read');
  await expect.poll(() => page.evaluate(() => (window as any).native.browser.sites())).toEqual([{ origin: site, level: 'read' }]);
  await expect(sites.getByRole('combobox', { name: `Your Chrome for ${site}`, exact: true })).toHaveValue('read');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  const navigate = `CUCALL ${browserTool(fake, 'navigate')} {"url":"${site}/"}`;
  const click = `CUCALL ${browserTool(fake, 'computer')} {"action":"left_click","coordinate":[20,20]}`;
  await sendCalls(page, [navigate, click]);
  await expect(card(page)).toContainText(`Allow ${who} to use ${site}`);
  await card(page).getByRole('radio', { name: 'Read only' }).click();
  await pickScope(card(page), /Allow in this chat/);
  await expect(transcript(page)).toContainText(`${site}/ (Logged-in page)`);
  await expect(transcript(page)).toContainText(`[cu: error: The user gave ${site} read-only access`);
  await expect(card(page)).toHaveCount(0);

  // 4. the user changes the site to Read and write in Settings; the same click now goes through
  // (the Sites table, #377: the site's "In-app browser" column holds its level for MoPilot's browser tools)
  await openBrowserSettings(harness);
  await expect(level).toHaveValue('read');
  await level.selectOption('write');
  await expect.poll(() => page.evaluate(() => (window as any).native.browser.sites())).toEqual([{ origin: site, level: 'write' }]);
  await expect(sites.getByRole('combobox', { name: `Your Chrome for ${site}`, exact: true })).toHaveValue('read');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await sendCalls(page, [navigate, click, `CUCALL ${browserTool(fake, 'get_page_text')} {}`]);
  await expect(transcript(page)).toContainText('Second page');
  await expect(card(page)).toHaveCount(0);
  // The streamed reply still carries browser_state after the page text; wait for the turn before quitting.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}

test.describe('Codex', () => {
  // the journey covers Your Chrome over the Playwright Extension: a build without MoPilot's own extension
  test.use({ harnesses: 'codex', seed: { files: remoteFlags(WITHOUT_OWN_EXTENSION) } });
  test('use-my-chrome on Codex: choose Your Chrome, the site card, the Chrome channel, read only until Read and write', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Codex', 'fake-codex');
  });
});

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude', seed: { files: remoteFlags(WITHOUT_OWN_EXTENSION) } });
  test('use-my-chrome on Claude Code: choose Your Chrome, the site card, the Chrome channel, read only until Read and write; --no-chrome', async ({
    page,
    harness,
  }) => {
    await journey(page, harness, 'Claude Code', 'fake-claude');
    // every SDK session (not the `claude auth status` probe) ran without Claude in Chrome
    const starts = harness.claudeLog().filter((e: any) => e.kind === 'argv' && e.argv.includes('stream-json')) as any[];
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s.argv).toContain('--no-chrome');
  });
});

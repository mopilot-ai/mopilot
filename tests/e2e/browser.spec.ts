// The built-in browser channel: the fake Claude CLI calls sage_browser_* through its SDK server, main
// drives a BrowserPanel tab over CDP, and each new site asks for a site permission on a card.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { builtinBrowserPages, test, expect, sendAppCommand } from './fixtures/app';
import { BUILTIN, CHROME, WITHOUT_OWN_EXTENSION, choosePreferredBrowser, preferredBrowser } from './fixtures/preferredBrowser';
import { remoteFlags } from './fixtures/flags';
import { pickScope } from './fixtures/approvalScope';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await expect(composer).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const PAGE = '<!doctype html><title>Fixture page</title><h1>Hello from the fixture</h1><p>pineapple-42</p><a href="/two">Next</a>';

/** A local site serving PAGE for the tests of the describe block that calls it; `port` is set once it listens. */
function localSite() {
  const site = { port: 0 };
  let server: http.Server;
  test.beforeAll(async () => {
    server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site.port = (server.address() as AddressInfo).port;
  });
  test.afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  return site;
}

test.describe('Claude', () => {
  test.use({ harnesses: 'claude' });
  const local = localSite();

  // With the in-app browser, Claude drives it through the browser_* tools, presented on their own server
  // (mopilot_browser) under short names; sage_browser_* stay only for Your Chrome (electron/capabilities/visibility.cjs).
  // A tab the agent opened closes when its turn ends, so the first turn opens, reads and tries to click in one go.
  test('navigate and read a local page with the in-app browser tools; every new site needs a grant', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    const first = `http://127.0.0.1:${local.port}`;
    const calls = [
      `CUCALL mcp__mopilot_browser__navigate {"url":"${first}/"}`,
      'CUCALL mcp__mopilot_browser__get_page_text {}',
      'CUCALL mcp__mopilot_browser__read_page {}',
      'CUCALL mcp__mopilot_browser__computer {"action":"left_click","coordinate":[20,20]}',
    ];
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(calls.join('\n'));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // the first visit asks for the site; a local server can be allowed for this chat, never for good
    const card = page.locator('.sage-approval');
    await expect(card).toContainText(`Allow Claude Code to use ${first}`);
    await expect(card.getByRole('button', { name: /Always allow/ })).toHaveCount(0);

    // The browser page waiting for consent stays in the panel's partition, sandboxed and unloaded.
    await expect
      .poll(async () =>
        harness.app.evaluate(({ webContents, session }) =>
          webContents
            .getAllWebContents()
            .filter((w) => w.session === session.fromPartition('persist:browser'))
            .map((w) => {
              const prefs: any = w.getLastWebPreferences() || {};
              return {
                loaded: w.getURL().startsWith('http'),
                panelPartition: w.session === session.fromPartition('persist:browser'),
                defaultSession: w.session === session.defaultSession,
                preload: prefs.preload || null,
                nodeIntegration: !!prefs.nodeIntegration,
                sandbox: !!prefs.sandbox,
              };
            }),
        ),
      )
      .toEqual([{ loaded: false, panelPartition: true, defaultSession: false, preload: null, nodeIntegration: false, sandbox: true }]);

    // it asks to read and write; the person gives read only
    await expect(card.getByRole('radio', { name: 'Read and write' })).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('radio', { name: 'Read only' }).click();
    await pickScope(card, /Allow in this chat/);
    await expect(transcript(page)).toContainText(`${first}/ (Fixture page)`);
    await expect(transcript(page)).toContainText('pineapple-42');
    await expect(transcript(page)).toContainText('heading "Hello from the fixture"');
    // read only: clicking is refused without another card
    await expect(transcript(page)).toContainText(`[cu: error: ${first} is read only for this chat`);
    await expect(card).toHaveCount(0);

    // a second origin (same server, other host name) asks again; denying it fails the call
    const second = `http://localhost:${local.port}`;
    await send(page, `CUCALL mcp__mopilot_browser__navigate {"url":"${second}/"}`);
    await expect(card).toContainText(`Allow Claude Code to use ${second}`);
    await card.getByRole('button', { name: /Deny/ }).click();
    await expect(transcript(page)).toContainText(`[cu: error: The user did not allow ${second}.`);

    // a grant for this chat is not saved for the site: nothing is on disk, and Settings → Browser lists no site
    expect(await page.evaluate(() => (window as any).native.browser.sites())).toEqual([]);
    await sendAppCommand(harness, 'settings');
    await page.locator('.side-row', { hasText: 'Browser' }).click();
    await expect(page.getByRole('table', { name: 'Sites' })).toContainText('No saved sites yet');
  });
});

// a build without MoPilot's own extension keeps Your Chrome over the Playwright Extension
test.describe('Claude, without MoPilot’s extension', () => {
  test.use({ harnesses: 'claude', seed: { files: remoteFlags(WITHOUT_OWN_EXTENSION) } });
  const local = localSite();

  test('Your Chrome: chosen in Settings → Browser, run by @playwright/mcp in a utility process; Claude starts with --no-chrome', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await sendAppCommand(harness, 'settings');
    await page.locator('.side-row', { hasText: 'Browser' }).click();
    await expect(preferredBrowser(page)).toHaveText(BUILTIN);
    await choosePreferredBrowser(page, CHROME);
    await expect(preferredBrowser(page)).toHaveText(CHROME);
    const extension = page.locator('.settings-row').filter({ has: page.getByText('Playwright Extension', { exact: true }) });
    await expect(extension.getByRole('button', { name: 'Get the extension', exact: true })).toBeVisible();
    // the connection test runs the pinned CLI for real; this profile's HOME has no Chrome, so it says so
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.locator('.settings-row', { hasText: 'Test connection' })).toContainText('Playwright Extension not found', {
      timeout: 30_000,
    });
    expect(await page.evaluate(() => (window as any).native.browser.chromeState())).toMatchObject({ active: 'chrome', hasToken: false });
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await expect(home(page)).toBeVisible();

    // an agent's call goes to its chat's own @playwright/mcp, after the same site permission card
    const site = `http://127.0.0.1:${local.port}`;
    await send(page, `CUCALL sage_browser_navigate {"url":"${site}/"}`);
    const card = page.locator('.sage-approval');
    await expect(card).toContainText(`Allow Claude Code to use ${site}`);
    await pickScope(card, /Always allow/);
    await expect(transcript(page)).toContainText('[cu: error: ', { timeout: 30_000 });
    // the tool's refusal says what is missing (electron/capabilities/browser/extensionTools.cjs)
    await expect(transcript(page)).toContainText("Your Chrome isn't set up: the Playwright Extension isn't installed");
    // no built-in browser tab was opened for it
    expect(await builtinBrowserPages(harness)).toBe(0);
    // @playwright/mcp runs in a utility process of the app
    const kids = await harness.app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((m) => m.type === 'Utility')
        .map((m) => m.name),
    );
    expect(kids).toContain('MoPilot Your Chrome');

    // every SDK session (not the `claude auth status` probe) ran without Claude in Chrome
    const starts = harness.claudeLog().filter((e: any) => e.kind === 'argv' && e.argv.includes('stream-json')) as any[];
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s.argv).toContain('--no-chrome');
  });
});

test.describe('Claude in Chrome migration note', () => {
  test.use({
    harnesses: 'claude',
    seed: {
      files: ({ home }) => fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true })),
    },
  });

  // the dev build ships MoPilot's extension, which serves Claude without Claude in Chrome by default (CM-Z32)
  test("shown in the next Claude chat; Set up opens Browser settings on MoPilot's extension and the note is gone for good", async ({
    page,
  }) => {
    const note = page.locator('.claude-in-chrome-note');
    await expect(home(page)).toBeVisible();
    await send(page, 'hello');
    await expect(transcript(page).getByText('fake-claude: hello')).toBeVisible();
    await expect(note).toContainText("Claude uses your Chrome through MoPilot's extension");
    await note.getByRole('button', { name: 'Set up', exact: true }).click();
    // lands on Settings → Browser with the channel unchanged: Your Chrome would hide the chrome_* tools (#1631)
    await expect(preferredBrowser(page)).toHaveText(BUILTIN);
    // the extension's one row speaks for Claude too (paired or not yet): no Claude row, and no way to Your Chrome
    const extensionRow = page.locator('.settings-row').filter({ has: page.getByText('MoPilot extension', { exact: true }) });
    await expect(extensionRow).toBeVisible();
    await expect(page.locator('.settings-row', { hasText: 'Claude Code · Chrome' })).toHaveCount(0);
    const chromeGroup = page.locator('section.settings-group', { has: page.getByRole('heading', { name: 'Chrome', exact: true }) });
    await expect(chromeGroup).not.toContainText('Use Your Chrome');
    await expect(note).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).native.browser.claudeInChromeNote())).toBe(false);
  });

  test('the Browser page shows it too, and closing it keeps it closed', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await sendAppCommand(harness, 'settings');
    await page.locator('.side-row', { hasText: 'Browser' }).click();
    const note = page.locator('.claude-in-chrome-note');
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Dismiss' }).click();
    await expect(note).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).native.browser.claudeInChromeNote())).toBe(false);
  });
});

// CUJ chrome-foreign-frame on Claude Code, with Google Chrome and MoPilot's real extension: another extension injects its own frame into the login page the agent's tab is on (a password manager's inline menu), Chrome force-detaches MoPilot's debugger with target_closed while the tab stays open, and the chat's next step still drives that tab instead of being refused as "taken back" (#2325).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { injectForeignFrame, dismissForeignFrame } from './fixtures/foreignFrame.mjs';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const FRAME_EXTENSION = path.join(__dirname, 'fixtures', 'frame-extension');
const LOGIN = '<!doctype html><title>Sign in</title><h1>Sign in</h1><form><input name="user"><input type="password" name="pw"></form>';
let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body =
      req.url === '/login'
        ? LOGIN
        : req.url === '/three'
          ? '<!doctype html><title>Page three</title><h1>Three</h1>'
          : '<!doctype html><title>Front page</title><h1>Front</h1>';
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function sendFromPanel(panel: Page, text: string) {
  const box = panel.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'claude' });

test('chrome-foreign-frame on Claude Code: another extension’s frame detaching the debugger keeps the tab the chat’s', async ({
  page,
  harness,
  launchChrome,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const chrome = await launchChrome();
  const frameExtension = await chrome.loadExtension(FRAME_EXTENSION);
  const welcome = await pairWithAllow(page, chrome);
  // every debugger detach Chrome reports to the extension, with its reason
  await welcome.evaluate(() => {
    const seen = ((globalThis as any).__detached = [] as { tabId: number; reason: string }[]);
    (globalThis as any).chrome.debugger.onDetach.addListener((source: { tabId: number }, reason: string) =>
      seen.push({ tabId: source.tabId, reason }),
    );
  });
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  const panel = await side.panel();
  await expect(panel.getByRole('heading', { name: 'Before you start' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'I understand' }).click();
  await panel.getByRole('button', { name: 'Next' }).click();
  await panel.getByRole('button', { name: 'Let’s go' }).click();
  await expect(panel.locator('#model')).toContainText('Fake Opus');

  // 1. The panel admitted this existing page's origin; same-origin navigation reuses that consent.
  const login = `${site}login`;
  // The product detaches at turn end. Hold the fake's native turn after streaming its tool reply,
  // so the real debugger remains attached until the test has triggered and observed the detach.
  const release = path.join(harness.dir, 'fake-claude.jsonl.release');
  const hold = path.join(harness.dir, 'fake-claude.jsonl.hold-next');
  fs.writeFileSync(hold, '');
  let released = false;
  try {
    await sendFromPanel(panel, `CUCALL mcp__mopilot_chrome__navigate ${JSON.stringify({ url: login })}`);
    await expect(panel.locator('#cards .card')).toHaveCount(0);
    // A held turn need not publish a final reply bubble; the native handshake below proves the actual login page is ready.
    await expect(panel.locator('#stop')).toBeVisible();

    // 2. prove the exact login tab has both the injector and MoPilot's live debugger before injecting.
    let injected = null as { tabId: number; triggerError: string; eventOffset: number } | null;
    await expect
      .poll(
        async () => {
          injected = await welcome.evaluate(injectForeignFrame, login);
          return injected !== null;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const { tabId, triggerError, eventOffset } = injected!;
    // The real Chrome event, filtered to this tab, is required; no synthetic detach can satisfy it.
    await expect
      .poll(
        () =>
          welcome.evaluate(
            ({ id, offset }) =>
              (globalThis as any).__detached.slice(offset).some((e: any) => e.tabId === id && e.reason === 'target_closed'),
            { id: tabId, offset: eventOffset },
          ),
        { timeout: 20_000, message: `Native detach for login tab ${tabId}; trigger: ${triggerError || 'acknowledged'}` },
      )
      .toBe(true);
    expect(chrome.context.pages().some((p) => p.url() === login)).toBe(true);

    // Chrome may still refuse a debugger while the other extension's menu is present.
    // This journey tests retained tab ownership after a real detach, independently of frame-guard recovery.
    const loginPage = chrome.context.pages().find((p) => p.url() === login)!;
    await expect(loginPage.locator('#injected-menu')).toHaveCount(1);
    expect(await loginPage.evaluate(dismissForeignFrame)).toBe(true);
    await expect(loginPage.locator('#injected-menu')).toHaveCount(0);
    await expect.poll(() => loginPage.frames().filter((f) => f.url().startsWith(`chrome-extension://${frameExtension}/`)).length).toBe(0);

    fs.writeFileSync(release, '');
    released = true;
    await expect(panel.locator('#stop')).toBeHidden({ timeout: 30_000 });

    // 3. the chat's next step drives the same tab
    await sendFromPanel(panel, `CUCALL mcp__mopilot_chrome__navigate ${JSON.stringify({ url: `${site}three` })}`);
    const reply = panel.locator('#rows .reply').last();
    await expect(reply).toContainText('Page three', { timeout: 30_000 });
    await expect(reply).not.toContainText('no longer');
    expect(
      await welcome.evaluate(
        async (url) => (await (globalThis as any).chrome.tabs.query({})).filter((t: any) => t.url === url).map((t: any) => t.id),
        `${site}three`,
      ),
    ).toEqual([tabId]);
    expect(chrome.context.pages().filter((p) => p.url().startsWith(site) && p.url() !== site)).toHaveLength(1);
  } finally {
    fs.rmSync(hold, { force: true });
    if (!released) fs.writeFileSync(release, '');
  }
});

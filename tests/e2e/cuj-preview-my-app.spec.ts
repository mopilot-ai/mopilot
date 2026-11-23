// CUJ preview-my-app: approved local servers reopen after app restart on both harnesses; denied starts remain refused.
// e2e-covers: electron/app/devPreviewWiring.cjs electron/capabilities/browser/devPreview/saved.cjs electron/capabilities/browser/views.cjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, builtinBrowserPages, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const card = (page: Page) => page.locator('.sage-approval');

interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}` };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}` };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;

async function sendCalls(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pick(page: Page, w: Way) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
const expectIdle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/** A project whose dev server is a tiny node server on `port`. */
async function addProject(h: Harness, port: number) {
  const folder = path.join(h.dir, 'home', 'work', 'demo');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'server.mjs'),
    `import http from 'node:http';\nhttp.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Demo</title><h1>Preview of demo</h1>')).listen(${port}, '127.0.0.1');\n`,
  );
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(h.page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(h.page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
}

async function journey(page: Page, harness: Harness, w: Way) {
  await expect(home(page)).toBeVisible();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const command = `"${process.execPath}" server.mjs`;
  await addProject(harness, port);
  // adding a project opens a new chat in it
  await expect(page.getByRole('button', { name: 'Change project: demo' })).toBeVisible();
  await pick(page, w);

  // 1. the agent starts the dev server: the Dev server card asks, then the site card for its page
  await sendCalls(page, [call(w, 'preview_start', { command, url }), call(w, 'get_page_text')]);
  await expect(card(page)).toHaveAttribute('data-kind', 'devServer');
  await expect(card(page)).toContainText('to start a dev server?');
  await card(page).getByRole('button', { name: 'Allow in this chat' }).click();
  await expect(card(page)).toContainText(`Allow ${w.who} to use ${url}`);
  await pickScope(card(page), /Allow in this chat/);
  // 2. it opened in the chat's built-in browser tab, and the agent read the page
  await expect(transcript(page)).toContainText(`Opened ${url}`);
  await expect(transcript(page)).toContainText('Preview of demo');
  await expectIdle(page);

  // Panes belong to the window. Reopen the saved chat's preview link after quit killed its server.
  const chatId = await page.locator('.thread-view').getAttribute('data-thread-id');
  await harness.quit();
  await expect
    .poll(() =>
      fetch(url, { signal: AbortSignal.timeout(1000) }).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await harness.relaunch();
  page = harness.page;
  await sidebar(page).locator(`[data-sidebar-chat="${chatId}"]`).first().click();
  await transcript(page).getByRole('link', { name: url, exact: true }).last().click();
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      harness.app.evaluate(async ({ webContents, session }, address) => {
        const wc = webContents
          .getAllWebContents()
          .find(
            (w) => !w.isDestroyed() && w.session === session.fromPartition('persist:browser') && w.getURL().replace(/\/$/, '') === address,
          );
        return wc ? wc.executeJavaScript('document.querySelector("h1")?.textContent').catch(() => null) : null;
      }, url),
    )
    .toBe('Preview of demo');
  await expect(page.locator('.browser-notice[role="alert"]')).toHaveCount(0);
  expect(await builtinBrowserPages(harness)).toBeGreaterThan(0);
  // the server is the chat's: listed as running
  await sendCalls(page, [call(w, 'preview_list')]);
  await expect(transcript(page)).toContainText('Preview servers in this chat:');
  await expect(transcript(page)).toContainText('[ready]');
  await expect(
    transcript(page)
      .getByText(new RegExp(url.replace(/[.:/]/g, '\\$&')))
      .last(),
  ).toBeVisible();
  await expectIdle(page);

  // 3. another chat: the user denies the dev server, and the agent is told why
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pick(page, w);
  await sendCalls(page, [call(w, 'preview_start', { command: 'npm run dev', url: 'http://127.0.0.1:1/' }), call(w, 'preview_list')]);
  await expect(card(page)).toHaveAttribute('data-kind', 'devServer');
  await card(page).getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page)).toContainText('[cu: error:');
  await expectIdle(page);
}

for (const views of [true, false]) {
  test.describe(views ? 'Main-owned preview tabs' : 'Legacy preview guests', () => {
    test.use({ harnesses: 'both', env: { MOPILOT_FLAGS: `shared.browser.viewTabs=${Number(views)}` } });
    test('preview restart on Codex: the saved page starts its server again; Deny refuses', async ({ page, harness }) => {
      await journey(page, harness, CODEX);
    });
    test('preview restart on Claude Code: the saved page starts its server again; Deny refuses', async ({ page, harness }) => {
      await journey(page, harness, CLAUDE);
    });
  });
}

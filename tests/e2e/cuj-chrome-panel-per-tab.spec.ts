// CUJ chrome-panel-per-tab on Claude Code, with Google Chrome and MoPilot's real extension: each tab has its own side panel (#2325). A chat started in one tab's panel stays that tab's; another tab's panel opens on a new chat; the first tab's panel opened again shows its chat.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>`),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'claude' });

test('chrome-panel-per-tab on Claude Code: a tab keeps its chat, another tab starts empty', async ({ page, launchChrome }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const first = await chrome.context.newPage();
  await first.goto(`${site}one`);
  const one = await chrome.sidePanel(welcome, first);
  const state = (p: typeof one) =>
    p.inPanel(`({ title: document.getElementById('title')?.textContent, tab: document.getElementById('tab-title')?.textContent,
      chat: document.getElementById('chat')?.hidden === false, chatId: document.getElementById('chat')?.dataset.chatId,
      consent: document.getElementById('consent')?.hidden === false })`);
  await expect.poll(() => state(one), { timeout: 30_000 }).toMatchObject({ tab: 'Page /one' });
  // Drive the actual side-panel document over CDP, not a second copy opened in a tab.
  await completePanelFirstRun(one);
  await expect.poll(() => one.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await one.inPanel(`(() => {
    const select = document.getElementById('harness'); select.value = 'claude'; select.dispatchEvent(new Event('change'));
    const text = document.getElementById('text'); text.value = 'Hello from tab one'; text.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
  await expect.poll(() => state(one), { timeout: 30_000 }).toMatchObject({ chat: true });
  const firstChatId = (await state(one)).chatId;
  expect(firstChatId).toBeTruthy();
  await expect
    .poll(() => one.inPanel(`document.getElementById('rows').textContent`), { timeout: 30_000 })
    .toMatch(/fake-claude: [\s\S]*Hello from tab one/);

  // another tab's own panel: its own tab, and a new chat
  const second = await chrome.context.newPage();
  await second.goto(`${site}two`);
  const two = await chrome.sidePanel(welcome, second);
  await expect.poll(() => state(two), { timeout: 30_000 }).toMatchObject({ tab: 'Page /two', chat: false, title: 'New chat' });

  await first.bringToFront();
  const again = await chrome.sidePanel(welcome, first);
  const tabId = await again.inPanel(`Number(new URL(location.href).searchParams.get('tabId'))`);
  const saved = await welcome.evaluate(async (id) => {
    const key = 'panelChat:' + id;
    return (await (globalThis as any).chrome.storage.session.get(key))[key];
  }, tabId);
  expect(saved.id).toBe(firstChatId);
  // A marker must disappear, proving that recovery ran in a new document.
  const reload = async () => {
    await again.inPanel(`globalThis.__panelReloadMarker = 'old-document'; setTimeout(() => location.reload(), 0); true`);
    await expect.poll(() => again.inPanel(`globalThis.__panelReloadMarker ?? null`), { timeout: 30_000 }).toBe(null);
  };
  await again.inPanel(
    `(() => { const text = document.getElementById('text'); text.value = 'Unsent draft'; text.dispatchEvent(new Event('input')); })()`,
  );
  await expect
    .poll(() =>
      welcome.evaluate(async (id) => (await (globalThis as any).chrome.storage.session.get('panelDraft:' + id))['panelDraft:' + id], tabId),
    )
    .toBe('Unsent draft');
  await reload();
  await expect.poll(() => again.inPanel(`document.getElementById('text').value`)).toBe('Unsent draft');
  await expect.poll(() => state(again), { timeout: 30_000 }).toMatchObject({ tab: 'Page /one', chat: true, chatId: firstChatId });
  await expect
    .poll(() => again.inPanel(`document.getElementById('rows').textContent`), { timeout: 30_000 })
    .toMatch(/fake-claude: [\s\S]*Hello from tab one/);
  await again.inPanel(`document.getElementById('new').click()`);
  await reload();
  await expect.poll(() => state(again), { timeout: 30_000 }).toMatchObject({ chat: false, title: 'New chat' });
});

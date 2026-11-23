// The panel's first real Chrome tool acts on its existing tab, preserving an unsaved form, scroll and open dialog instead of reopening the URL.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');
let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Current page</title>
<h1>Current page</h1><label>Draft <input id="draft" value="initial"></label><div style="height:1800px"></div><dialog id="terms">Unsubmitted dialog</dialog>`),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/state`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});
test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'claude' });

test('chrome-panel-current-tab on Claude Code: read the panel tab in place before any model tool, with unsaved state intact', async ({
  page,
  launchChrome,
}) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await expect.poll(() => side.inPanel(`document.getElementById('tab-title')?.textContent`), { timeout: 30_000 }).toBe('Current page');
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  const tabId = await welcome.evaluate(async (url) => {
    const tabs = (await (globalThis as any).chrome.tabs.query({})).filter((t: any) => t.url === url);
    if (tabs.length !== 1) throw new Error('Expected one existing stateful page');
    return tabs[0].id as number;
  }, site);
  const before = await front.evaluate(() => {
    (document.querySelector('#draft') as HTMLInputElement).value = 'Unsaved form data';
    (document.querySelector('#terms') as HTMLDialogElement).show();
    window.scrollTo(0, 700);
    return {
      value: (document.querySelector('#draft') as HTMLInputElement).value,
      scroll: window.scrollY,
      open: (document.querySelector('#terms') as HTMLDialogElement).open,
    };
  });
  await side.inPanel(`(() => {
    const harness = document.getElementById('harness'); harness.value = 'claude'; harness.dispatchEvent(new Event('change'));
    const input = document.getElementById('text'); input.value = ${JSON.stringify(`CUCALL mcp__mopilot_chrome__read_page ${JSON.stringify({ tabId, filter: 'all' })}`)};
    input.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit();
  })()`);
  const state = () =>
    side.inPanel(`({ cards: document.getElementById('cards')?.textContent,
    rows: document.getElementById('rows')?.textContent, error: document.getElementById('error')?.textContent })`);
  // Auto may already permit this local page's read; answer a real site card when one is required.
  await expect
    .poll(
      async () => {
        const value = await state();
        return value.cards?.includes('Allow in this chat')
          ? 'ask'
          : value.rows?.includes('Unsaved form data')
            ? 'read'
            : JSON.stringify(value);
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(ask|read)$/);
  if ((await state()).cards?.includes('Allow in this chat')) await side.click('#cards button[data-choice="chat"]');
  await expect.poll(() => side.inPanel(`document.getElementById('rows')?.textContent`), { timeout: 30_000 }).toContain('Unsaved form data');
  const ownership = await welcome.evaluate(async (id) => {
    const api = (globalThis as any).chrome;
    const tab = await api.tabs.get(id);
    const saved = (await api.storage.session.get('sessions')).sessions;
    return {
      grouped: tab.groupId >= 0,
      owners: Object.values(saved ?? {}).filter((s: any) => s.tabs.includes(id) && s.groupId === tab.groupId).length,
    };
  }, tabId);
  expect(ownership).toEqual({ grouped: true, owners: 1 });
  const after = await front.evaluate(() => ({
    value: (document.querySelector('#draft') as HTMLInputElement).value,
    scroll: window.scrollY,
    open: (document.querySelector('#terms') as HTMLDialogElement).open,
  }));
  expect(after).toEqual(before);
  const tabs = await welcome.evaluate(
    async (url) => (await (globalThis as any).chrome.tabs.query({})).filter((t: any) => t.url === url).map((t: any) => t.id),
    site,
  );
  expect(tabs).toEqual([tabId]);
  expect(chrome.context.pages().filter((p) => p.url().startsWith('http://127.0.0.1:'))).toHaveLength(1);
});

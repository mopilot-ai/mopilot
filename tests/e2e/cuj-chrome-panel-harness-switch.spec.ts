// The side panel's Harness rows in Chrome's real per-tab frame, on fake Codex and Claude Code: a new chat's harness picked
// in the model menu, then that chat switched to the other harness for its next message, which lands there; the permission
// menu's title and the chevrons are checked on the way, with screenshots of each menu.
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Harness switch fixture</title><h1>Local page</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});
test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'both' });

/** The model menu's rows as text: a heading as "# …", a row's name with ✓ when picked and its second line in brackets. */
const MENU_ROWS = `[...document.querySelectorAll('#model-rows > *')].map(c => c.tagName === 'H4' ? '# ' + c.textContent
  : (c.children[0]?.textContent ?? c.textContent) + (c.getAttribute('aria-checked') === 'true' ? ' ✓' : '') + (c.children[1] ? ' (' + c.children[1].textContent + ')' : ''))`;

test('a chat started on Codex in the side panel moves to Claude Code with its next message', async ({ page, launchChrome }, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBe(2);
  const row = (label: string) =>
    side.inPanel(
      `[...document.querySelectorAll('#model-rows > button')].findIndex(b => b.children[0]?.textContent === ${JSON.stringify(label)}) + 1`,
    );
  const pick = async (label: string) =>
    side.click(
      `#model-rows > :nth-child(${await side.inPanel(`[...document.querySelectorAll('#model-rows > *')].findIndex(b => b.children?.[0]?.textContent === ${JSON.stringify(label)}) + 1`)})`,
    );

  // the model menu opens on the effort; its title row leads to the harnesses and models, as the app's picker
  const openList = async () => {
    await side.click('#model');
    await side.click('#model-rows > .effort-title');
  };
  // a new chat: the harnesses head the list, and a pick stays in the panel until the first message
  await openList();
  await expect.poll(() => side.inPanel(`(${MENU_ROWS}).slice(0, 3)`)).toEqual(expect.arrayContaining(['‹ Harness']));
  expect(await row('Codex')).toBeGreaterThan(0);
  await side.screenshot(info.outputPath('new-chat-menu.png'));
  await pick('Codex');
  await expect.poll(() => side.inPanel(`document.getElementById('harness').value`)).toBe('codex');
  await expect.poll(() => side.inPanel(`document.getElementById('model').textContent`)).not.toBe('Choose model');

  // the chevrons are drawn shapes, not a font's glyph
  const chevron = await side.inPanel(`(() => { const s = getComputedStyle(document.getElementById('perm'), '::after');
    return { content: s.content, mask: (s.maskImage || s.webkitMaskImage).startsWith('url("data:image/svg+xml'), width: s.width }; })()`);
  expect(chevron).toEqual({ content: '""', mask: true, width: '10px' });
  // a label cut short by its ellipsis still shows its chevron inside the pill
  const fits = await side.inPanel(`(() => { const b = document.getElementById('perm').getBoundingClientRect();
    const s = getComputedStyle(document.getElementById('perm'), '::after');
    return parseFloat(s.right) + parseFloat(s.width) <= parseFloat(getComputedStyle(document.getElementById('perm')).paddingRight) && b.width > 0; })()`);
  expect(fits).toBe(true);

  const send = (text: string) =>
    side.inPanel(
      `(() => { const t=document.getElementById('text'); t.value=${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`,
    );
  await send('Plan a weekend in Taipei');
  await expect.poll(() => side.inPanel(`document.getElementById('meta').textContent`), { timeout: 30_000 }).toContain('Codex');
  await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 60_000 }).toBe('Done');

  // the permission menu is MoPilot's own setting, whichever harness the chat runs on
  await side.click('#perm');
  await expect.poll(() => side.inPanel(`document.querySelector('#perm-menu h4')?.textContent`)).toBe('What MoPilot can do');
  await side.screenshot(info.outputPath('permission-menu.png'));
  await side.click('#perm');

  // the open chat: its harness is checked, and the other one waits for the next message
  await openList();
  await expect.poll(() => side.inPanel(MENU_ROWS)).toEqual(expect.arrayContaining(['Codex ✓', 'Claude Code']));
  await pick('Claude Code');
  // the menus read again for the harness the next message goes to, then the menu opens on them
  await expect.poll(() => side.inPanel(MENU_ROWS)).toEqual(expect.arrayContaining(['Codex', 'Claude Code ✓ (From your next message)']));
  await side.click('#model');
  await expect.poll(() => side.inPanel(`document.getElementById('model-menu').hidden`)).toBe(false);
  await side.screenshot(info.outputPath('switch-pending.png'));
  await side.click('#model');

  // the next message lands on Claude Code, in the same chat
  const chatId = await side.inPanel(`document.getElementById('chat').dataset.chatId`);
  await send('Now find a hotel near Taipei 101');
  await expect.poll(() => side.inPanel(`document.getElementById('meta').textContent`), { timeout: 60_000 }).toContain('Claude Code');
  await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 60_000 }).toBe('Done');
  expect(await side.inPanel(`document.getElementById('chat').dataset.chatId`)).toBe(chatId);
  await openList();
  await expect.poll(() => side.inPanel(MENU_ROWS)).toEqual(expect.arrayContaining(['Codex', 'Claude Code ✓']));
  await side.screenshot(info.outputPath('switched.png'));
});

// CUJ chrome-panel-b1-header-composer on Claude Code, with Google Chrome and MoPilot's real extension (#3046, batch B1): the side
// panel's toolbar has a bottom hairline; the model, permission and + menus close on Escape (focus back on their button) and on a press
// outside; and a disabled Send is at 50%. No turn is run: the batch is about the panel's own controls.
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Header page</title><h1>Header</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'claude' });

test('chrome-panel-b1-header-composer on Claude Code: toolbar hairline, menus that close, and Send at 50%', async ({
  page,
  launchChrome,
}) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await side.inPanel(`(() => {
    const select = document.getElementById('harness'); select.value = 'claude'; select.dispatchEvent(new Event('change'));
  })()`);

  // the toolbar's hairline: 1px, solid, in the panel's line color, on the toolbar's own bottom edge
  const bar = await side.inPanel(`(() => {
    const bar = document.querySelector('.bar');
    const style = getComputedStyle(bar);
    const probe = document.createElement('div');
    probe.style.cssText = 'border: 1px solid var(--line); position: absolute; visibility: hidden';
    document.body.append(probe);
    const line = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return { width: style.borderBottomWidth, style: style.borderBottomStyle, color: style.borderBottomColor, line, top: style.borderTopWidth };
  })()`);
  expect(bar).toMatchObject({ width: '1px', style: 'solid', top: '0px' });
  expect(bar.color).toBe(bar.line);

  // an empty box: Send is disabled, at 50% (not 40%)
  await expect.poll(() => side.inPanel(`document.getElementById('send').disabled`)).toBe(true);
  expect(await side.inPanel(`getComputedStyle(document.getElementById('send')).opacity`)).toBe('0.5');
  await side.inPanel(`(() => {
    const text = document.getElementById('text'); text.value = 'Try it for me'; text.dispatchEvent(new Event('input'));
  })()`);
  await expect.poll(() => side.inPanel(`document.getElementById('send').disabled`)).toBe(false);
  expect(await side.inPanel(`getComputedStyle(document.getElementById('send')).opacity`)).toBe('1');

  // each menu closes on Escape, with focus back on the button that opened it
  const menus = [
    ['#model', '#model-menu'],
    ['#perm', '#perm-menu'],
    ['#plus', '#plus-menu'],
  ];
  await expect.poll(() => side.inPanel(`!document.getElementById('model').hidden`)).toBe(true);
  await expect.poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`)).toBe(true);
  for (const [button, menu] of menus) {
    await side.click(button);
    await expect.poll(() => side.inPanel(`!document.querySelector('${menu}').hidden`)).toBe(true);
    await side.inPanel(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await expect.poll(() => side.inPanel(`document.querySelector('${menu}').hidden`)).toBe(true);
    expect(await side.inPanel(`document.activeElement?.id`)).toBe(button.slice(1));
  }

  // and on a real press outside them. A tall menu (the model list) can cover the whole toolbar, so the press lands on a small
  // probe that sits over the toolbar's left edge, above every menu and in none of them
  for (const [button, menu] of menus) {
    await side.click(button);
    await expect.poll(() => side.inPanel(`!document.querySelector('${menu}').hidden`)).toBe(true);
    await side.inPanel(`(() => {
      const probe = document.createElement('div');
      probe.id = 'press-probe';
      probe.style.cssText = 'position: fixed; left: 0; top: 0; width: 8px; height: 8px; z-index: 2147483647';
      document.body.append(probe);
    })()`);
    await side.click('#press-probe');
    await side.inPanel(`document.getElementById('press-probe').remove()`);
    await expect.poll(() => side.inPanel(`document.querySelector('${menu}').hidden`)).toBe(true);
  }
  // a press on the button of the menu that is open toggles it shut as before: not closed twice, not reopened
  await side.click('#model');
  await expect.poll(() => side.inPanel(`!document.getElementById('model-menu').hidden`)).toBe(true);
  await side.click('#model');
  await expect.poll(() => side.inPanel(`document.getElementById('model-menu').hidden`)).toBe(true);
});

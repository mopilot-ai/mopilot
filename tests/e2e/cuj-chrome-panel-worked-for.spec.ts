// CUJ chrome-panel-worked-for on Claude Code, with Google Chrome and MoPilot's real extension (#3046): a finished turn that worked
// through several steps folds them under how long it worked ("Worked for 11s"), as ChatGPT's panel does, not "6 steps · Used a tool".
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let other: http.Server;
let site = '';
let otherSite = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Worked page</title><h1>Worked</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // a site the tab is not on: going there is what needs the user's OK
  other = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Other page</title><h1>Other</h1>'),
  );
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherSite = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
  other.closeAllConnections();
  other.close();
});

test.describe.configure({ timeout: 240_000 });
test.use({ harnesses: 'claude' });

test('chrome-panel-worked-for on Claude Code: a finished turn with steps says how long it worked', async ({ page, launchChrome }, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  const tabId = await welcome.evaluate(
    async (url) => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url).id,
    site,
  );
  // asking before acting: the steps wait for the user's OK, so the turn lasts (Full access would run them in a blink, under the second a duration needs)
  await expect.poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`)).toBe(true);
  await side.click('#perm');
  await expect
    .poll(() =>
      side.inPanel(`[...document.querySelectorAll('#perm-menu button')].some((b) => b.textContent.startsWith('Ask for approval'))`),
    )
    .toBe(true);
  const askIndex = await side.inPanel(
    `[...document.querySelectorAll('#perm-menu button')].findIndex((b) => b.textContent.startsWith('Ask for approval')) + 1`,
  );
  expect(askIndex).toBeGreaterThan(0);
  await side.click(`#perm-menu button:nth-of-type(${askIndex})`);
  const tool = (name: string) => `mcp__mopilot_chrome__${name}`;
  await side.inPanel(`(() => {
    const t = document.getElementById('text');
    t.value = ${JSON.stringify(
      `CUSTEPS\nCUCALL ${tool('navigate')} ${JSON.stringify({ tabId, url: otherSite })}\nCUCALL ${tool('read_page')} ${JSON.stringify({ tabId, filter: 'all' })}\nCUCALL ${tool('computer')} ${JSON.stringify({ tabId, action: 'screenshot' })}`,
    )};
    t.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
  // going to another site needs the user's OK: the time spent there is part of the turn
  await expect
    .poll(() => side.inPanel(`document.getElementById('cards').textContent`), { timeout: 60_000 })
    .toContain('Allow in this chat');
  // the time the card waits is part of the turn: at least the second a duration is shown from
  await page.waitForTimeout(1500);
  await side.click('#cards button[data-choice="chat"]');
  await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 90_000 }).toBe('Done');
  // the steps fold under how long the turn worked, not under their count
  await expect
    .poll(() => side.inPanel(`[...document.querySelectorAll('#rows details.steps > summary')].map((s) => s.textContent)`), {
      timeout: 60_000,
    })
    .toEqual([expect.stringMatching(/^Worked for (\d+m )?\d+[sm]$/)]);
  await side.screenshot(info.outputPath('worked-for.png'));
});

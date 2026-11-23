// CUJ chrome-panel-composer-look on Claude Code, with Google Chrome and MoPilot's real extension (#3046): the side panel's message
// box has no drag handle in its corner and grows with what is typed, as Claude's and ChatGPT's boxes do.
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Box page</title><h1>Box</h1>'),
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

test('chrome-panel-composer-look on Claude Code: the message box has no resize handle and grows with its text', async ({
  page,
  launchChrome,
}, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);

  const box = () =>
    side.inPanel(
      `(() => { const t = document.getElementById('text'); return { height: t.getBoundingClientRect().height, resize: getComputedStyle(t).resize }; })()`,
    );
  const empty = await box();
  expect(empty.resize).toBe('none');
  await side.inPanel(`(() => {
    const t = document.getElementById('text');
    t.value = 'one\\ntwo\\nthree\\nfour\\nfive';
    t.dispatchEvent(new Event('input'));
  })()`);
  await expect.poll(async () => (await box()).height).toBeGreaterThan(empty.height + 20);
  // bounded by its CSS, then it scrolls
  await side.inPanel(
    `(() => { const t = document.getElementById('text'); t.value = Array(60).fill('line').join('\\n'); t.dispatchEvent(new Event('input')); })()`,
  );
  await expect.poll(async () => (await box()).height).toBeLessThanOrEqual(181);
  await side.inPanel(`(() => { const t = document.getElementById('text'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);
  await expect.poll(async () => (await box()).height).toBeLessThanOrEqual(empty.height + 1);
  await side.screenshot(info.outputPath('composer.png'));
});

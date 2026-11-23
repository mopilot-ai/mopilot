// CUJ chrome-panel-bubble-space on Claude Code, with Google Chrome and MoPilot's real extension (#3046): a user message's bubble in
// the side panel is as tall as its text. Its Copy button used to be a clear block row inside the bubble, leaving blank space under the text.
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Bubble page</title><h1>Bubble</h1>'),
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

test('chrome-panel-bubble-space on Claude Code: a message bubble has no blank row under its text, and its Copy is beside it', async ({
  page,
  launchChrome,
}, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await side.inPanel(`(() => {
    const select = document.getElementById('harness'); select.value = 'claude'; select.dispatchEvent(new Event('change'));
    const text = document.getElementById('text'); text.value = 'Try it for me'; text.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
  await expect.poll(() => side.inPanel(`document.querySelectorAll('#rows .you').length`), { timeout: 60_000 }).toBeGreaterThan(0);

  // the blank space under the bubble's last content (its text, or the tab line a message from a page carries): the bubble's
  // bottom edge less its padding, less where its last in-flow child ends; a positioned child (Copy) takes no room
  const m = await side.inPanel(`(() => {
    const bubble = document.querySelector('#rows .you');
    const box = bubble.getBoundingClientRect();
    const style = getComputedStyle(bubble);
    const bottom = (n) => {
      if (n.nodeType === 3) {
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect().bottom;
      }
      return n.getBoundingClientRect().bottom;
    };
    const flow = [...bubble.childNodes].filter((n) => n.nodeType === 3 || getComputedStyle(n).position !== 'absolute');
    const copy = bubble.querySelector('.message-copy');
    return {
      blank: box.bottom - parseFloat(style.paddingBottom) - Math.max(...flow.map(bottom)),
      copyPosition: getComputedStyle(copy).position,
      copyBelowBubble: copy.getBoundingClientRect().top >= box.bottom - 1,
      kids: [...bubble.childNodes].map((n) => [n.nodeName, n.className ?? '', Math.round(bottom(n) - box.top), getComputedStyle(n.nodeType === 1 ? n : bubble).position]),
      height: box.height,
    };
  })()`);
  expect(m.blank, JSON.stringify(m.kids)).toBeLessThanOrEqual(2);
  expect(m.copyPosition).toBe('absolute');
  expect(m.copyBelowBubble).toBe(true);
  await side.screenshot(info.outputPath('bubble.png'));
});

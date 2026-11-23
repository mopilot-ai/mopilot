// CUJ chrome-panel-paste-image on Claude Code, with Google Chrome and MoPilot's real extension: a copied image pasted into the
// side panel's message box becomes a chip that goes with the message (it used to do nothing; only + > Add files attached one).
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Paste page</title><h1>Paste</h1>'),
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

/** A paste of one 1x1 PNG, as a copied screenshot arrives: a file in the clipboard, no text. */
const PASTE_PNG = `(() => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  const text = document.getElementById('text');
  const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  text.dispatchEvent(paste);
  return paste.defaultPrevented;
})()`;

test('chrome-panel-paste-image on Claude Code: a pasted image is a chip, and a paste of text stays text', async ({
  page,
  launchChrome,
}, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);

  expect(await side.inPanel(PASTE_PNG)).toBe(true);
  await expect
    .poll(() => side.inPanel(`[...document.querySelectorAll('#attached .chip')].map((c) => c.textContent)`), { timeout: 30_000 })
    .toEqual(['Pasted image.png×']);
  await side.screenshot(info.outputPath('pasted-image.png'));

  // a paste that carries text is the box's own: nothing is taken
  const taken = await side.inPanel(`(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'hello');
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('text').dispatchEvent(paste);
    return paste.defaultPrevented;
  })()`);
  expect(taken).toBe(false);
});

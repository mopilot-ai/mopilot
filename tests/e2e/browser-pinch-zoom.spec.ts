// A trackpad pinch on a page in the in-app browser zooms it, and an agent still acts on the page's layout (#5405): the page's visual viewport scale follows the gesture within the limits the tab sets, and an agent's call puts it back to 1 before it clicks.
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, expect, sendAppCommand, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

test.use({ harnesses: 'claude', env: { SAGE_DEBUG_PORT: '18798' } });

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pinch fixture</title><body style="margin:0"><button id="b" onclick="window.hits=(window.hits||0)+1" style="position:absolute;left:300px;top:200px;width:120px;height:40px">Target</button>',
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** The fixture page's visual viewport, or null while it isn't there; after a CDP pinch of `factor` at the middle of what is visible (the compositor's gesture, as the trackpad's) when given. */
async function pinch(h: Harness, factor?: number) {
  return h.app.evaluate(
    async ({ webContents }, [url, factor]) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(url as string));
      if (!wc) return null;
      const view = () =>
        wc.executeJavaScript(
          '({ scale: visualViewport.scale, w: visualViewport.width, h: visualViewport.height, inner: innerWidth, hits: window.hits || 0 })',
        );
      if (factor) {
        const { w, h } = await view();
        const own = !wc.debugger.isAttached();
        if (own) wc.debugger.attach('1.3');
        try {
          await wc.debugger.sendCommand('Input.synthesizePinchGesture', { x: w / 2, y: h / 2, scaleFactor: factor, relativeSpeed: 800 });
        } finally {
          if (own) wc.debugger.detach();
        }
      }
      return view();
    },
    [site, factor ?? 0] as const,
  );
}

test('a pinch zooms the in-app browser page in, and a pinch back out returns it', async ({ page, harness }) => {
  // a chat to show the pane beside (the home page has none)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Open a page for me');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.assistant-message').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await sendAppCommand(harness, 'open-browser-tab', site);
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toBeVisible();
  await expect.poll(() => pinch(harness).then((s) => s?.inner ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  const zoomedIn = (await pinch(harness, 2))!;
  console.log(`PINCH-IN ${JSON.stringify(zoomedIn)}`);
  expect(zoomedIn.scale).toBeGreaterThan(1.5);
  const zoomedOut = (await pinch(harness, 0.3))!;
  console.log(`PINCH-OUT ${JSON.stringify(zoomedOut)}`);
  expect(zoomedOut.scale).toBe(1);
});

const registryPath = path.resolve(__dirname, '../../electron/capabilities/contract/registry.cjs');

/** Holds the agent's turn after the page text is read, so its tab stays open while the user pinches. */
async function holdTurn(h: Harness, hold: boolean) {
  await h.app.evaluate(
    (_electron, [modulePath, hold]) => {
      const { Registry } = process.getBuiltinModule('module').createRequire(modulePath as string)(modulePath as string);
      if (!hold) return Registry.releasePinchReply?.();
      const invoke = Registry.prototype.invoke;
      Registry.prototype.invoke = async function (...args: any[]) {
        const out = await invoke.apply(this, args);
        if (args[2] === 'browser_get_page_text')
          await new Promise<void>((resolve) => {
            Registry.releasePinchReply = resolve;
          });
        return out;
      };
    },
    [registryPath, hold] as const,
  );
}

test('an agent click at a layout point still lands on a page the user pinch-zoomed', async ({ page, harness }) => {
  // the browser tools build only on macOS, so the PR check runs this spec on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
  test.skip(process.platform !== 'darwin', 'the browser tools build only on macOS');
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await holdTurn(harness, true);
  const call = (name: string, args: object) => `CUCALL mcp__mopilot_browser__${name} ${JSON.stringify(args)}`;
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill(
      [call('navigate', { url: site }), call('get_page_text', {}), call('computer', { action: 'left_click', coordinate: [360, 220] })].join(
        '\n',
      ),
    );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await pickScope(page.locator('.sage-approval'), /Allow in this chat/);
  try {
    await expect.poll(() => pinch(harness).then((s) => s?.inner ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
    // the user pinches while the agent waits
    expect((await pinch(harness, 2))!.scale).toBeGreaterThan(1.5);
  } finally {
    await holdTurn(harness, false);
  }
  // the agent's click: levelled to scale 1 first, so layout (360, 220) is the button
  await expect.poll(() => pinch(harness).then((s) => s?.hits)).toBe(1);
  console.log(`AGENT-CLICK ${JSON.stringify(await pinch(harness))}`);
  expect((await pinch(harness))!.scale).toBe(1);
});

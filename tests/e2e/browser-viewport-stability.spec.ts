// Checks painted text scale before and after an agent turn in a narrow IAB pane across harness families.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, expect, type Harness } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

let server: http.Server;
let site = '';
const registryPath = path.resolve(__dirname, '../../electron/capabilities/contract/registry.cjs');
test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Map viewport fixture</title>
      <style>body { margin: 16px; font: 16px Arial; } button { font: inherit; }</style>
      <h1>Nearby hotels</h1><button>Search this area</button><p id="label">Map labels stay readable</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Hold a completed page read, so the real browser operation has run but the harness turn remains active. */
async function holdReply(h: Harness) {
  await h.app.evaluate((_electron, modulePath) => {
    const { Registry } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath);
    const invoke = Registry.prototype.invoke;
    Registry.prototype.invoke = async function (...args) {
      const out = await invoke.apply(this, args);
      if (args[2] === 'browser_get_page_text') {
        await new Promise<void>((resolve) => {
          Registry.releaseViewportReply = resolve;
        });
      }
      return out;
    };
  }, registryPath);
}

async function releaseReply(h: Harness) {
  await h.app.evaluate((_electron, modulePath) => {
    const { Registry } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath);
    Registry.releaseViewportReply?.();
    Registry.releaseViewportReply = null;
  }, registryPath);
}

/** Compare page CSS pixels with the actual view on screen; a desktop-fit shrinks every painted glyph. */
async function textScale(h: Harness) {
  return h.app.evaluate(async ({ BrowserWindow }, url) => {
    const view = BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .flatMap((w) => w.contentView.children)
      .find((v: any) => v.webContents?.getURL().startsWith(url)) as any;
    if (!view) return null;
    const wc = view.webContents;
    const page = await wc.executeJavaScript(
      `({ width: innerWidth, font: parseFloat(getComputedStyle(document.querySelector('#label')).fontSize) })`,
    );
    return {
      width: page.width,
      pane: view.getBounds().width,
      font: page.font,
      scale: view.getBounds().width / wc.getZoomFactor() / page.width,
    };
  }, site);
}

/** Renderer screenshots omit native child views; capture the browser's actual painted surface instead. */
async function captureBrowser(h: Harness, file: string) {
  const png = await h.app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url));
    if (!wc) throw new Error('No fixture browser page');
    return (await wc.capturePage()).toPNG().toString('base64');
  }, site);
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
}

for (const family of ['codex', 'claude', 'acp'] as const) {
  test.describe(family, () => {
    test.use({
      harnesses: family === 'acp' ? 'none' : family,
      env: { SAGE_DEBUG_PORT: '18797' },
      acp: family === 'acp' ? { opencode: {} } : {},
      seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } },
    });
    test('opening, reading and finishing preserve readable text at the pane width', async ({ page, harness }) => {
      // needs a Mac, so the PR check runs this spec on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
      if (family === 'acp')
        test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
      await page.setViewportSize({ width: 1024, height: 682 });
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      await holdReply(harness);
      const call = (name: string, args: object) =>
        family === 'acp'
          ? `MCPTOOL browser_${name} ${JSON.stringify(args)}`
          : `CUCALL ${family === 'claude' ? 'mcp__mopilot_browser__' : 'browser_'}${name} ${JSON.stringify(args)}`;
      const prompt = [call('navigate', { url: site }), call('get_page_text', {})].join('\n');
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const approval = page.locator('.sage-approval');
      await expect(approval).toContainText(site);
      await pickScope(approval, /Allow in this chat/);
      let during: Awaited<ReturnType<typeof textScale>>;
      try {
        await expect
          .poll(() =>
            harness.app.evaluate((_electron, modulePath) => {
              const { Registry } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath);
              return !!Registry.releaseViewportReply;
            }, registryPath),
          )
          .toBe(true);
        await expect.poll(() => textScale(harness)).not.toBeNull();
        during = await textScale(harness);
        await captureBrowser(harness, test.info().outputPath('during-agent-turn.png'));
      } finally {
        await releaseReply(harness);
      }
      await expect(page.locator('button.send-btn.stop')).toHaveCount(0);
      await expect.poll(async () => (await textScale(harness))?.scale).toBeCloseTo(1, 1);
      const after = await textScale(harness);
      await captureBrowser(harness, test.info().outputPath('after-agent-turn.png'));
      console.log(JSON.stringify({ family, during, after }));
      expect(during!.pane).toBeLessThan(1280);
      expect(during!.font).toBe(16);
      expect(during!.scale).toBeCloseTo(1, 1);
      expect(during!.width).toBe(after!.width);
    });
  });
}

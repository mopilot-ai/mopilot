// Cmd +/-/0 on a page in the Artifact pane (#2600): main forwards the focused page's browser keys and the pane zooms
// the page for its site, as the browser pane does. claude.ai is faked in the shared profile (a signed-in cookie and an
// https handler serving the artifact page); the chat opens the page with show_pane.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const ARTIFACT = 'https://claude.ai/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';

test.use({ harnesses: 'claude' });

async function fakeClaude(h: Harness) {
  await h.app.evaluate(async ({ session, net }) => {
    const ses = session.fromPartition('persist:browser');
    await ses.cookies.set({ url: 'https://claude.ai', name: 'sessionKey', value: 'fixture', secure: true });
    ses.protocol.handle('https', (req) => {
      if (new URL(req.url).hostname !== 'claude.ai') return net.fetch(req, { bypassCustomProtocolHandlers: true });
      return new Response('<!doctype html><title>Neutral OS</title><h1>Neutral OS</h1><p>An artifact page.</p>', {
        headers: { 'content-type': 'text/html' },
      });
    });
  });
}

/** The artifact page's zoom factor, or null while it isn't there. */
const zoomOf = (h: Harness) =>
  h.app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(url));
    return wc ? wc.getZoomFactor() : null;
  }, ARTIFACT);

/** The app window's own zoom level (Cmd +/- with the app focused changes it). */
const windowZoom = (h: Harness) => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());

/**
 * The user presses a Cmd chord with the page focused. The window and the page take focus first (main forwards keys
 * only from a focused page); what main's before-input-event saw is kept for the failure message. When the runner's
 * window can't take OS focus, main's forward (browser:shortcut, as electron/capabilities/browser/browserShortcuts.cjs delivers it) stands in.
 */
async function press(h: Harness, key: string, combo: string) {
  const seen = await h.app.evaluate(
    async ({ webContents, BrowserWindow }, [url, key]) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(url));
      if (!wc) throw new Error('no artifact page');
      BrowserWindow.getAllWindows()[0]?.focus();
      wc.focus();
      const inputs: string[] = [];
      const log = (_e: unknown, i: any) => inputs.push(`${i.type}:${i.key}:${i.code}:${i.meta}`);
      wc.on('before-input-event', log);
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
      await new Promise((r) => setTimeout(r, 100));
      wc.removeListener('before-input-event', log);
      return { focused: wc.isFocused(), inputs, id: wc.id };
    },
    [ARTIFACT, key] as const,
  );
  if (seen.focused) return seen;
  // no OS focus on this runner: main's forward of that chord, the step the pane acts on
  await h.app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('browser:shortcut', payload);
    },
    { rootId: seen.id, combo },
  );
  return seen;
}

test('Cmd + and Cmd - zoom the Artifact pane page, and Cmd 0 fits it again', async ({ page, harness }) => {
  test.skip(process.platform !== 'darwin', 'the page keys are Cmd chords on macOS');
  await expect(home(page)).toBeVisible();
  await fakeClaude(harness);
  await composer(page).fill(`CUCALL show_pane ${JSON.stringify({ pane: 'artifact', url: ARTIFACT })}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.artifact-pane')).toBeVisible();
  await expect.poll(() => zoomOf(harness)).not.toBeNull();
  // the pane fits the page to its width once shown: read the zoom after that settles
  await page.waitForTimeout(500);
  const fit = (await zoomOf(harness)) as number;
  const windowBefore = await windowZoom(harness);

  const first = await press(harness, '=', '⌘=');
  test.info().annotations.push({ type: 'press', description: JSON.stringify(first) });
  await expect.poll(() => zoomOf(harness)).toBeGreaterThan(fit);
  const bigger = (await zoomOf(harness)) as number;
  await press(harness, '-', '⌘-');
  await press(harness, '-', '⌘-');
  await expect.poll(() => zoomOf(harness)).toBeLessThan(bigger);
  await press(harness, '0', '⌘0');
  await expect.poll(() => zoomOf(harness)).toBeCloseTo(fit, 2);
  // the window's own zoom never moved: the keys went to the page
  expect(await windowZoom(harness)).toBe(windowBefore);
});

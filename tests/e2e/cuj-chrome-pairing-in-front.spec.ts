// CUJ chrome-pairing-in-front (#2449): the user turns MoPilot's extension on in Chrome while the app's window is out of the way. The extension's page says "click Allow in MoPilot", so MoPilot's window has to come back with the question: the app's one Allow is there, and the page is connected after it.
import type { Harness } from './fixtures/app';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

/** The app's window (the page, never Quick Chat or the browser pane's parking window): shown or not. */
const shown = (h: Pick<Harness, 'app'>) =>
  h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => {
      const url = w.webContents.getURL();
      return url.startsWith('file:') && !url.includes('#mini');
    });
    return win ? win.isVisible() && !win.isMinimized() : null;
  });

const hide = (h: Pick<Harness, 'app'>) =>
  h.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      if (w.webContents.getURL().startsWith('file:') && !w.webContents.getURL().includes('#mini')) w.hide();
  });

test.use({ harnesses: 'codex' });

test('chrome-pairing-in-front: the app window comes back with "Allow Chrome to connect?", and its one Allow pairs', async ({
  page,
  harness,
  launchChrome,
}) => {
  await expect(page.getByRole('main')).toBeVisible();
  // the app is behind Chrome, as it is when the user turns the extension on there
  await hide(harness);
  await expect.poll(() => shown(harness)).toBe(false);
  const chrome = await launchChrome();
  // the extension asks through the native host by itself: the window is back before anyone looks for it
  await expect.poll(() => shown(harness), { timeout: 45_000 }).toBe(true);
  await pairWithAllow(page, chrome);
});

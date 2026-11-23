// A file downloaded from a page in the Artifact pane (#2595): a Claude Docs export saved to the downloads folder with
// nothing in the pane to say so, so it looked lost. The pane now shows the browser pane's Download complete notice
// under its bar and the Downloads button and list. claude.ai is faked in the shared profile (a signed-in cookie and an
// https handler serving the artifact page and its file); the chat opens the page with show_pane.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const pane = (page: Page) => page.locator('.artifact-pane');
const ARTIFACT = 'https://claude.ai/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';

test.use({ harnesses: 'claude' });

/** claude.ai in the shared profile: signed in, the artifact page with an export link, and the file it downloads. */
async function fakeClaude(h: Harness) {
  await h.app.evaluate(async ({ session, net }) => {
    const ses = session.fromPartition('persist:browser');
    await ses.cookies.set({ url: 'https://claude.ai', name: 'sessionKey', value: 'fixture', secure: true });
    ses.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      if (u.hostname !== 'claude.ai') return net.fetch(req, { bypassCustomProtocolHandlers: true });
      if (u.pathname === '/export.pdf')
        return new Response('%PDF-1.4 fixture', {
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Neutral OS.pdf"' },
        });
      return new Response('<!doctype html><title>Neutral OS</title><h1>Neutral OS</h1><a id="dl" href="/export.pdf">Export PDF</a>', {
        headers: { 'content-type': 'text/html' },
      });
    });
  });
}

/** The user clicks the page's export link (a real click in the page, with a user gesture). */
async function clickExport(h: Harness) {
  await h.app.evaluate(async ({ webContents }, url) => {
    const page = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(url));
    if (!page) throw new Error('no artifact page');
    await page.executeJavaScript("document.getElementById('dl').click()", true);
  }, ARTIFACT);
}

test('a download from the Artifact pane says Download complete there, and the Downloads button lists it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await fakeClaude(harness);
  await composer(page).fill(`CUCALL show_pane ${JSON.stringify({ pane: 'artifact', url: ARTIFACT })}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane(page)).toBeVisible();
  // the page shows (signed in), not the wall
  await expect(pane(page).locator('.artifact-wall')).toHaveCount(0);
  await expect
    .poll(() =>
      harness.app.evaluate(
        ({ webContents }, url) => webContents.getAllWebContents().some((w) => !w.isDestroyed() && w.getURL().startsWith(url)),
        ARTIFACT,
      ),
    )
    .toBe(true);
  await expect(pane(page).locator('.browser-downloads-btn')).toHaveCount(0);

  await clickExport(harness);
  const notice = pane(page).locator('.browser-download-slot > .browser-download-notice');
  await expect(notice).toHaveAttribute('aria-label', 'Download complete: Neutral OS.pdf');
  await expect(notice.getByRole('button', { name: 'Show in folder' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('artifact-download-notice.png') });

  // the bar's Downloads button opens the list with the file
  await pane(page).locator('.artifact-pane-bar .browser-downloads-btn').click();
  await expect(page.locator('.browser-downloads .browser-download-name')).toHaveText(['Neutral OS.pdf']);
  await page.screenshot({ path: test.info().outputPath('artifact-downloads-list.png') });
});

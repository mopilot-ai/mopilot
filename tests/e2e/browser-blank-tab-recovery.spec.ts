// A built-in browser tab that never had a web page, in the real app (#3988): its renderer crashes, its notice's Reload brings it back, and the Chrome card's buttons each answer.
import { test, expect, sendAppCommand } from './fixtures/app';

test.describe('Blank browser tab', () => {
  test.use({ harnesses: 'claude' });

  test('a crashed blank tab reloads, and the Chrome card says what its button needs', async ({ page, harness }, testInfo) => {
    // a chat to show the pane beside (the home page has none)
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Open a page for me');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.assistant-message').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await sendAppCommand(harness, 'open-browser-tab', 'about:blank');
    await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toBeVisible();
    const blankPage = () =>
      harness.app.evaluate(({ webContents, session }) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && w.session === session.fromPartition('persist:browser') && w.getURL() === 'about:blank');
        return wc ? { id: wc.id, crashed: wc.isCrashed(), loading: wc.isLoading() } : null;
      });
    await expect.poll(async () => (await blankPage())?.loading).toBe(false);

    await harness.app.evaluate(({ webContents, session }) => {
      webContents
        .getAllWebContents()
        .find((w) => !w.isDestroyed() && w.session === session.fromPartition('persist:browser') && w.getURL() === 'about:blank')!
        .forcefullyCrashRenderer();
    });
    const alert = page.locator('.browser-notice[role="alert"]');
    await expect(alert).toContainText('This page crashed');
    // a page with no web address has nothing for its notice to hand off
    await expect(alert.locator('.browser-notice-actions button')).toHaveText(['Reload']);
    await page.screenshot({ path: testInfo.outputPath('crashed.png') });

    await alert.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect.poll(async () => (await blankPage())?.crashed).toBe(false);

    // a route that opens in the user's Chrome, whatever this runner has installed; nothing here opens Chrome itself
    await harness.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('browser:handoffRoute');
      ipcMain.handle('browser:handoffRoute', () => 'extension');
    });
    const toolbar = page.locator('.browser-chrome-btn');
    await toolbar.click();
    const card = page.locator('.browser-handoff');
    await expect(card).toContainText('Open this site in your Chrome');
    await expect(toolbar).toBeDisabled();
    const open = card.getByRole('button', { name: 'Open in Chrome', exact: true });
    await expect(open).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('chrome-card.png') });
    // every toolbar button stays in the pane, and clicking one leaves the pane where it is
    expect(
      await page.locator('.browser-bar').evaluate((bar) => {
        let scrolled = 0;
        for (let el: Element | null = bar; el; el = el.parentElement) scrolled += el.scrollLeft;
        return { fits: bar.scrollWidth <= bar.clientWidth, scrolled };
      }),
    ).toEqual({ fits: true, scrolled: 0 });
    await card.getByRole('textbox', { name: 'Site to continue in Chrome' }).fill('javascript:alert(1)');
    await open.click();
    await expect(card.getByRole('alert')).toHaveText('Enter a web address.');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(toolbar).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('after.png') });
  });
});

// The browser pane's find bar in the real app: ⌘F with the pane focused opens it, typing finds through Chromium's own
// find in the page (main's view or the <webview>), the count is the page's, Enter steps and Esc closes it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, sendAppCommand } from './fixtures/app';

const PAGE = '<!doctype html><title>Find fixture</title><p>pineapple one</p><p>pineapple two</p><p>mango</p>';

test.describe('Find in page', () => {
  test.use({ harnesses: 'claude' });
  let server: http.Server;
  let url = '';
  test.beforeAll(async () => {
    server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  test.afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test('⌘F opens the find bar on the pane, counts the page’s matches, steps with Enter and closes with Esc', async ({ page, harness }) => {
    // a chat to show the pane beside (the home page has none)
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Open a page for me');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.assistant-message').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await sendAppCommand(harness, 'open-browser-tab', url);
    const address = page.getByRole('textbox', { name: 'Browser address', exact: true });
    await expect(address).toBeVisible();
    await expect
      .poll(() =>
        harness.app.evaluate(
          ({ webContents }, url) => webContents.getAllWebContents().some((w) => w.getURL() === url && !w.isLoading()),
          url,
        ),
      )
      .toBe(true);
    await address.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+F');
    const field = page.getByRole('textbox', { name: 'Find in page', exact: true });
    await expect(field).toBeFocused();
    await field.fill('pineapple');
    const count = page.locator('.browser-find .chat-find-count');
    await expect(count).toHaveText('1 of 2');
    await field.press('Enter');
    await expect(count).toHaveText('2 of 2');
    await field.press('Shift+Enter');
    await expect(count).toHaveText('1 of 2');
    await field.fill('kiwi');
    await expect(count).toHaveText('No results');
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    // Esc closed the find bar only: the pane and its page stay
    await expect(address).toBeVisible();
  });
});

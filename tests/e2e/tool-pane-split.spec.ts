// Real right-pane splits retain an editor, native browser and shell through layout, focus, resize and chat changes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { test, expect, sendAppCommand } from './fixtures/app';
import { sizeViewport } from './fixtures/window';
import { shootBoth, SYSTEM_THEME } from './fixtures/shoot';

const win32 = process.platform === 'win32';
// the terminal's shell: PowerShell on Windows (src/lib/platform.ts defaultShell), a POSIX shell elsewhere
const SET_VAR = win32 ? "$env:SPLIT_RETAINED = 'kept_shell'" : 'export SPLIT_RETAINED=kept_shell';
const PRINT_VAR = win32 ? 'Write-Output "SPLIT_MARKER_$env:SPLIT_RETAINED"' : 'printf "SPLIT_MARKER_$SPLIT_RETAINED\\n"';

for (const family of ['codex', 'claude'] as const)
  test.describe(`Tool splits on ${family}`, () => {
    test.use({
      harnesses: family,
      // This native-responder journey runs on an isolated runner; the default background fixture cannot focus windows.
      env: { SAGE_E2E_BACKGROUND: '0' },
      seed: { uiState: { prefs: { ...SYSTEM_THEME.prefs, fontSize: 24, zoomLevel: 0, defaultTerminal: 'right' } } },
    });
    test('keeps several tools visible, focused and recoverable without recreating their resources', async ({ page, harness }, testInfo) => {
      test.setTimeout(150_000);
      const server = http.createServer((_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<title>Split browser</title><h1>Split browser</h1><input aria-label="Retained page" value="kept page">'),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
        const folder = path.join(harness.dir, 'home', 'split-tools');
        fs.mkdirSync(folder, { recursive: true });
        for (const name of ['note.ts', 'second.ts']) fs.writeFileSync(path.join(folder, name), 'export const retained = true;\n');
        await harness.app.evaluate(({ dialog }, folder) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
        }, folder);
        await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
        await page
          .getByRole('textbox', { name: 'Message', exact: true })
          .fill(['note.ts', 'second.ts'].map((name) => `[${name}](${pathToFileURL(path.join(folder, name)).href})`).join('\n\n'));
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        const reply = page.locator('.assistant-message');
        await expect(reply.getByRole('link', { name: 'note.ts', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        const chatId = await page.locator('.thread-view').getAttribute('data-thread-id');
        expect(chatId).toBeTruthy();
        await sizeViewport(page, harness, 1440, 900);
        await reply.getByRole('link', { name: 'note.ts', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Edit note.ts', exact: true });
        await editor.fill('export const retained = "unsaved draft";\n');
        await sendAppCommand(harness, 'open-terminal');
        const terminal = page.locator('.pane-term .xterm-helper-textarea');
        await expect(terminal).toBeVisible();
        await terminal.focus();
        await page.keyboard.type(SET_VAR);
        await page.keyboard.press('Enter');
        const tabs = page.locator('.tb-tabs');
        const tab = (name: string) => tabs.getByRole('button', { name, exact: true });
        await tab('note.ts').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Show beside current tool', exact: true }).click();
        const visible = page.locator('.tool-pane-grid > .pane-tab-body:not([hidden]):not(.pane-tab-back)');
        await expect(visible).toHaveCount(2);
        await expect(editor).toHaveValue('export const retained = "unsaved draft";\n');
        await expect(terminal).toBeVisible();
        const divider = page.getByRole('separator', { name: 'Resize tool panes 1 and 2', exact: true });
        await divider.focus();
        await page.keyboard.press('ArrowRight');
        await expect(divider).toHaveAttribute('aria-valuenow', '55');
        const box = (await divider.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 60, box.y + box.height / 2);
        await page.mouse.up();
        await expect.poll(() => divider.getAttribute('aria-valuenow')).not.toBe('55');
        await divider.dblclick();
        await expect(divider).toHaveAttribute('aria-valuenow', '50');
        await shootBoth(page, harness.app, 'two-tool-columns');
        await tabs.getByRole('button', { name: 'New tab', exact: true }).click();
        const address = page.getByRole('textbox', { name: 'Browser address', exact: true });
        await address.fill(url);
        await address.press('Enter');
        await expect
          .poll(() =>
            harness.app
              .context()
              .pages()
              .some((p) => p.url() === url),
          )
          .toBe(true);
        const browser = harness.app
          .context()
          .pages()
          .find((p) => p.url() === url)!;
        await expect(browser.getByRole('textbox', { name: 'Retained page' })).toBeVisible();
        await tab('note.ts').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Show below current tool', exact: true }).click();
        await expect(visible).toHaveCount(3);
        await expect
          .poll(() =>
            harness.app.evaluate(({ BrowserWindow }, url) => {
              const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'))!;
              return win.contentView.children.some((view) => {
                const wc = (view as Electron.WebContentsView).webContents;
                return wc?.getURL() === url && view.getBounds().height > 0;
              });
            }, url),
          )
          .toBe(true);
        // Drive the native first responder, then select a different tool so this focus event cannot satisfy
        // the subsequent input-selection assertions by itself. CDP page clicks alone do not activate a native window.
        const nativeFocus = () =>
          harness.app.evaluate(
            ({ BrowserWindow, webContents }, url) => ({
              window: BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().startsWith('file:') && w.isFocused()),
              page:
                webContents
                  .getAllWebContents()
                  .find((wc) => wc.getURL() === url)
                  ?.isFocused() ?? false,
            }),
            url,
          );
        await harness.app.evaluate(({ app, BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'))!;
          app.focus({ steal: true });
          win.show();
          win.focus();
        });
        await expect.poll(async () => (await nativeFocus()).window).toBe(true);
        await expect
          .poll(async () => {
            await harness.app.evaluate(({ webContents }, url) => {
              webContents
                .getAllWebContents()
                .find((wc) => wc.getURL() === url)!
                .focus();
            }, url);
            return nativeFocus();
          })
          .toEqual({ window: true, page: true });
        await expect(tab('Split browser')).toHaveAttribute('aria-current', 'true');
        const selectEditor = async () => {
          await page.locator('.tool-tile-head').getByRole('button', { name: 'note.ts', exact: true }).click();
          await expect(tab('note.ts')).toHaveAttribute('aria-current', 'true');
          await expect.poll(nativeFocus).toEqual({ window: true, page: true });
        };
        await selectEditor();
        const field = browser.getByRole('textbox', { name: 'Retained page' });
        await field.click();
        await expect(tab('Split browser')).toHaveAttribute('aria-current', 'true');
        await field.fill('page state survives');
        await selectEditor();
        // Native keyboard input goes through WebContents, rather than CDP's renderer-only key injection.
        const keys = await harness.app.evaluate(async ({ webContents }, url) => {
          const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url)!;
          const seen: string[] = [];
          const log = (_event: unknown, input: { type: string }) => seen.push(input.type);
          wc.on('before-input-event', log);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
          await new Promise((resolve) => setTimeout(resolve, 30));
          wc.removeListener('before-input-event', log);
          return { focused: wc.isFocused(), seen };
        }, url);
        await testInfo.attach('native-key-input.json', { body: JSON.stringify(keys), contentType: 'application/json' });
        expect(keys.seen).toContain('keyDown');
        await testInfo.attach('native-page-focus.json', {
          body: JSON.stringify(
            await harness.app.evaluate(({ webContents }, url) => {
              const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
              return { found: !!wc, focused: wc?.isFocused() };
            }, url),
          ),
          contentType: 'application/json',
        });
        await expect(tab('Split browser')).toHaveAttribute('aria-current', 'true');
        await reply.getByRole('link', { name: 'second.ts', exact: true }).click();
        await tab('Split browser').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Show below current tool', exact: true }).click();
        await expect(visible).toHaveCount(4);
        await sizeViewport(page, harness, 1024, 900);
        await expect(page.getByRole('button', { name: 'Arrange tools in rows', exact: true })).toBeVisible();
        await expect.poll(async () => (await page.locator('.browser-view').boundingBox())?.height ?? 0).toBeGreaterThan(0);
        await expect(field).toBeInViewport({ ratio: 0.5 });
        await shootBoth(page, harness.app, 'four-tool-rows-narrow');
        await tab('second.ts').hover();
        await tabs.getByRole('button', { name: 'Close second.ts tab', exact: true }).click();
        await expect(visible).toHaveCount(3);
        await expect(editor).toHaveValue('export const retained = "unsaved draft";\n');
        await reply.getByRole('link', { name: 'second.ts', exact: true }).click();
        await tab('Split browser').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Show below current tool', exact: true }).click();
        await expect(visible).toHaveCount(4);

        await sendAppCommand(harness, 'new-chat');
        // Projects and Recents can both render this chat; reopen by its stable identity.
        await page
          .getByRole('complementary')
          .locator(`[data-sidebar-chat=${JSON.stringify(chatId)}]`)
          .first()
          .click();
        await expect(page.locator('.thread-view')).toHaveAttribute('data-thread-id', chatId!);
        await expect(visible).toHaveCount(4);
        await expect(editor).toHaveValue('export const retained = "unsaved draft";\n');
        await expect(browser.getByRole('textbox', { name: 'Retained page' })).toHaveValue('page state survives');
        await terminal.focus();
        await expect(tab('split-tools')).toHaveAttribute('aria-current', 'true');
        // Return the native responder from the child page to the app before driving its terminal textarea.
        await harness.app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().startsWith('file:'))!
            .webContents.focus();
        });
        await expect
          .poll(() =>
            harness.app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find((w) => w.webContents.getURL().startsWith('file:'))!
                .webContents.isFocused(),
            ),
          )
          .toBe(true);
        await terminal.pressSequentially(PRINT_VAR, { delay: 10 });
        await terminal.press('Enter');
        await expect(page.locator('.pane-term .xterm-rows')).toContainText('SPLIT_MARKER_kept_shell');
        await page.getByRole('button', { name: 'Return to one tool pane', exact: true }).click();
        await expect(visible).toHaveCount(1);
        await expect(terminal).toBeVisible();
        await tab('note.ts').click();
        await expect(editor).toHaveValue('export const retained = "unsaved draft";\n');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

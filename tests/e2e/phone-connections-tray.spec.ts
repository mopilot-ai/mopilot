// The native tray's hierarchy, honest mixed-phone count and route into Settings, in the isolated fake app.
// e2e-covers: electron/app/menu.cjs electron/app/alwaysOn.cjs electron/app/phoneTray.cjs electron/remote/phoneDevices.cjs
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures/app';

test.skip(process.platform !== 'darwin', 'native macOS menu-bar rendering');
// Native screenshots need real focus; the default fake-app background mode replaces show/focus with inactive no-ops.
test.use({ env: { SAGE_E2E_BACKGROUND: '0' } });

// Each capture owns one native tracking session and a fresh app fixture.
for (const view of ['menu', 'details'] as const) {
  test(`the native phone ${view} separates live connections from saved phones and opens their settings`, async ({
    harness,
    page,
  }, testInfo) => {
    const root = path.resolve(__dirname, '../..');
    // firstWindow resolves before boot installs the command listener; production commandMainWindow waits for readiness too.
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('mopilot:boot:done').length > 0)).toBe(true);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    try {
      const result = await harness.app.evaluate(async ({ app, BrowserWindow, Menu, Tray, nativeImage, shell }, root) => {
        const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
        const fs = process.getBuiltinModule('fs');
        const os = process.getBuiltinModule('os');
        const path = process.getBuiltinModule('path');
        const { createAlwaysOn } = require(`${root}/electron/app/alwaysOn.cjs`);
        const { createMenus } = require(`${root}/electron/app/menu.cjs`);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-tray-'));
        const window = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL().startsWith('file:') && !w.webContents.getURL().includes('#mini'),
        )!;
        const devices = ['Personal phone', 'Work phone'].map((name, id) => ({
          id: String(id),
          pairId: String(id),
          name,
          lastSeenAt: null,
          createdAt: Date.now(),
        }));
        let online = '0';
        const live: any = {
          remote: {
            running: true,
            devices: { list: () => devices, isRetired: () => false },
            presence: { isOnline: (id: string) => id === online, isAbsent: (id: string) => id !== online },
            channel: { pairs: () => ['0', '1'], statsOf: () => null, closedReason: () => null, onPairsChanged: () => () => {} },
          },
        };
        let menus: any;
        let menu: Electron.Menu;
        const alwaysOn = createAlwaysOn({
          app,
          BrowserWindow,
          powerSaveBlocker: null,
          userData: dir,
          live,
          ignored: () => {},
          flagOn: () => true,
          onChange: () => {},
          refreshTray: () => menus?.refreshTray(),
        });
        live.alwaysOn = alwaysOn;
        alwaysOn.set({ keepRunning: true });
        menus = createMenus({
          Menu: {
            buildFromTemplate: (items: Electron.MenuItemConstructorOptions[]) => (menu = Menu.buildFromTemplate(items)),
            setApplicationMenu: Menu.setApplicationMenu,
          },
          Tray,
          nativeImage,
          shell,
          globalShortcut: {},
          BrowserWindow,
          APP_NAME: 'MoPilot',
          isDev: false,
          isWin: false,
          live,
          win: {
            windows: new Set([window]),
            mainWindow: () => window,
            createWindow: () => {},
            showMainWindow: async () => window.show(),
            toggleMini: () => {},
            commandMainWindow: async (command: string, arg: string) => {
              window.show();
              window.webContents.send('app:command', command, arg);
            },
          },
        });
        menus.refreshTray();
        const labels = menu!.items.map((item) => (item.type === 'separator' ? 'separator' : item.label));
        const phones = menu!.items[4].submenu!;
        const details = phones.items.map((item) => (item.type === 'separator' ? 'separator' : item.label));
        online = '';
        alwaysOn.sync();
        const offline = menu!.items[4].submenu!.items.map((item) => item.label);
        online = '0';
        alwaysOn.sync();
        (globalThis as any).__phoneTrayCheck = { menus, alwaysOn, menu: menu!, dir, window };
        app.focus({ steal: true });
        window.show();
        window.focus();
        return { labels, details, offline };
      }, root);
      expect(result.labels).toEqual([
        'Open MoPilot',
        'New Chat',
        'Open Quick Chat',
        'separator',
        'Phones · 1 connected',
        'separator',
        'Quit MoPilot',
      ]);
      expect(result.details).toEqual([
        '1 connected · 2 paired',
        'Personal phone — Connected',
        'Work phone — Offline',
        'separator',
        'Manage phones…',
      ]);
      expect(result.offline.slice(0, 3)).toEqual(['0 connected · 2 paired', 'Personal phone — Offline', 'Work phone — Offline']);
      await harness.app.evaluate(() => {
        const { menu } = (globalThis as any).__phoneTrayCheck;
        const item = menu.items[4].submenu.items.at(-1);
        item.click();
      });
      await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
      await harness.app.evaluate(async ({ Menu }, view) => {
        const state = (globalThis as any).__phoneTrayCheck;
        // Details renders the actual submenu rows in its own native popup; Settings routing above uses the original item.
        const popup =
          view === 'menu'
            ? state.menu
            : Menu.buildFromTemplate(
                state.menu.items[4].submenu.items.map((item: Electron.MenuItem) => ({
                  label: item.label,
                  type: item.type,
                  enabled: item.enabled,
                  click: item.click,
                })),
              );
        state.popup = popup;
        let closed!: () => void;
        state.popupClosed = new Promise<void>((resolve) => {
          closed = resolve;
        });
        await new Promise<void>((resolve) => {
          popup.once('menu-will-show', () => resolve());
          popup.popup({ window: state.window, x: 24, y: 24, callback: closed });
        });
      }, view);
      const screenshot = testInfo.outputPath(`native-phone-${view}.png`);
      execFileSync('screencapture', ['-x', screenshot]);
      await testInfo.attach(`Native phone ${view}`, { path: screenshot, contentType: 'image/png' });
      await harness.app.evaluate(async () => {
        const state = (globalThis as any).__phoneTrayCheck;
        state.popup.closePopup(state.window);
        await state.popupClosed;
      });
    } finally {
      await harness.app.evaluate(() => {
        const state = (globalThis as any).__phoneTrayCheck;
        if (!state) return;
        state.popup?.closePopup(state.window);
        state.alwaysOn.close();
        state.menus.tray.destroy();
        process.getBuiltinModule('fs').rmSync(state.dir, { recursive: true, force: true });
        delete (globalThis as any).__phoneTrayCheck;
      });
    }
  });
}

// The app menu and the tray in the interface's language (electron/app/menu.cjs): every label reads the lookup, roles too,
// since Electron's own role labels are English without a .lproj for each language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMenus } = require('../electron/app/menu.cjs');

function appMenu(isWin: boolean) {
  let template: any[] = [];
  let trayMenu: any[] = [];
  const win = { webContents: { send: () => undefined } };
  class Tray {
    setToolTip() {}
    setContextMenu(menu: any[]) {
      trayMenu = menu;
    }
    on() {}
  }
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: (t: any[]) => void (template = t) },
    Tray,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
    globalShortcut: {},
    shell: { openExternal: () => undefined },
    BrowserWindow: { getFocusedWindow: () => win },
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin,
    win: {
      windows: new Set([win]),
      mainWindow: () => win,
      createWindow() {},
      showMainWindow: async () => {},
      commandMainWindow: async () => {},
      toggleMini() {},
    },
    live: { updater: null },
    notice: () => undefined,
    t: (text: string, values: unknown[] = []) => `«${text}»${values.join()}`,
  });
  menus.buildMenu();
  menus.setTray(true);
  return { template, trayMenu, menus, tray: () => trayMenu };
}

const labels = (items: any[]): string[] =>
  items.flatMap((item) => [...(item.type === 'separator' ? [] : [item.label]), ...labels(Array.isArray(item.submenu) ? item.submenu : [])]);

test('every item of the app menu and the tray goes through the lookup, on both platforms', () => {
  for (const isWin of [false, true]) {
    const { template, trayMenu } = appMenu(isWin);
    // the hidden items that only carry extra accelerators have no one to read them
    const shown = (items: any[]): any[] =>
      items
        .filter((item) => item.visible !== false)
        .map((item) => (Array.isArray(item.submenu) ? { ...item, submenu: shown(item.submenu) } : item));
    const all = [...labels(shown(template)), ...labels(trayMenu)];
    assert.ok(all.length > 40);
    assert.deepEqual(
      all.filter((label) => !label?.startsWith?.('«') && label !== 'MoPilot'),
      [],
    );
  }
});

test('a label that names the app takes it as a value, so a translation can place it', () => {
  const { template, trayMenu } = appMenu(false);
  assert.ok(labels(template).includes('«About {0}»MoPilot'));
  assert.ok(labels(trayMenu).includes('«Show {0}»MoPilot'));
});

test('rebuilding the menus redraws the menu-bar item, whose labels a new language renames too', () => {
  const { menus, tray, trayMenu } = appMenu(false);
  menus.buildMenu();
  assert.notEqual(tray(), trayMenu);
});

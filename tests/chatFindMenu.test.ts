// Edit → Find in Chat, sent to the focused window as the find-in-chat shortcut; its ⌘F is the app's only while the app's own
// UI has focus, so a browser page's find and a shell's Ctrl+F keep theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMenus } = require('../electron/app/menu.cjs');
const { resolveShortcut } = await import('../shared/shortcuts.mjs');

function editMenu(isWin: boolean) {
  let template: any[] = [];
  const sent: unknown[][] = [];
  const win = { webContents: { send: (...args: unknown[]) => sent.push(args) } };
  const menus = createMenus({
    Menu: { buildFromTemplate: (t: any[]) => t, setApplicationMenu: (t: any[]) => void (template = t) },
    Tray: class {},
    nativeImage: {},
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
    live: {},
    notice: () => {},
  });
  menus.buildMenu();
  return { items: template.find((m) => m.label === 'Edit').submenu, sent };
}

test('Edit → Find in Chat sends the find-in-chat shortcut and holds no accelerator, on macOS and Windows', () => {
  for (const isWin of [false, true]) {
    const { items, sent } = editMenu(isWin);
    const item = items.find((i: any) => i.label === 'Find in Chat');
    assert.equal(item.accelerator, undefined);
    item.click();
    assert.deepEqual(sent, [['app:command', 'shortcut', { id: 'find-in-chat' }]]);
    // nor a hidden one: a menu key would take ⌘F from a browser page and Ctrl+F from a terminal
    assert.equal(items.filter((i: any) => i.accelerator === 'CmdOrCtrl+F').length, 0);
  }
});

test('⌘F resolves to find in the chat in the app, to the page’s find in a browser page, and to nothing in a terminal', () => {
  assert.equal(resolveShortcut('⌘F', {}, 'app')?.id, 'find-in-chat');
  // a focused page finds in itself (browserPanel/FindBar.tsx), never in the chat
  assert.equal(resolveShortcut('⌘F', {}, 'browser')?.id, 'browser-find');
  assert.equal(resolveShortcut('⌘F', {}, 'terminal'), null);
  // other chat actions still reach a focused page, as before
  assert.equal(resolveShortcut('⇧⌘A', {}, 'browser')?.id, 'archive');
  // a key rebound onto find keeps the same rule
  assert.equal(resolveShortcut('⌥⌘F', { 'find-in-chat': '⌥⌘F' }, 'browser'), null);
});

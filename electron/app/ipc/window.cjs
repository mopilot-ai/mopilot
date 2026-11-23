// IPC for windows and the desktop: context menus, dialogs, shell and clipboard, Quick Chat and voice hotkeys, app icons, window chrome.
const { fs } = require('../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { createLinuxDesktop } = require('../linuxDesktop.cjs');
const { appMenus } = require('../contextMenu.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps & { contextMenus?: typeof appMenus }} deps what main.cjs passes every IPC
 *   module; `contextMenus` is a test's stand-in for the app windows' menus
 */
function register(ipcMain, deps) {
  const {
    Menu,
    BrowserWindow,
    dialog,
    shell,
    isWin,
    openInWindows,
    run,
    clipboard,
    createWindow,
    toggleMini,
    setTray,
    setMiniShortcut,
    setVoiceHotkey,
    WIN_APP_PATHS,
    app,
    winExists,
    nativeTheme,
    windows,
    zoom,
    contextMenus = appMenus,
  } = deps;
  const linux =
    process.platform === 'linux'
      ? createLinuxDesktop({
          which: (name) => require('../../platform/env.cjs').which(name),
          exists: fs.existsSync,
          isDirectory: (file) => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false,
          run,
        })
      : null;
  // Native context menu: items are {id, label, enabled?, checked?, type?, accelerator?, submenu?}; resolves with the chosen id.
  ipcMain.handle(
    'menu:popup',
    (e, items) =>
      new Promise((resolve) => {
        let chosen = null;
        const build = (list) =>
          list.map((it) =>
            it.type === 'separator'
              ? { type: 'separator' }
              : {
                  label: it.label,
                  enabled: it.enabled !== false,
                  type: it.checked !== undefined ? 'checkbox' : 'normal',
                  checked: !!it.checked,
                  accelerator: it.accelerator,
                  submenu: it.submenu ? build(it.submenu) : undefined,
                  click: it.submenu ? undefined : () => (chosen = it.id),
                },
          );
        const menu = Menu.buildFromTemplate(build(items));
        // Electron takes a missing window as no parent
        menu.popup({
          window: /** @type {Electron.BaseWindow} */ (BrowserWindow.fromWebContents(e.sender)),
          callback: () => setTimeout(() => resolve(chosen), 0),
        });
      }),
  );

  // A picture's menu (Copy Image, Save Image As…, Show in Finder when it is a file): electron/app/contextMenu.cjs.
  ipcMain.handle('menu:image', (e, image) => contextMenus.showImageMenu(e.sender, { src: image?.src, path: image?.path }));

  ipcMain.handle('dialog:openFolder', async (e) => {
    // Electron's dialogs take a missing window as no parent
    const w = /** @type {Electron.BaseWindow} */ (BrowserWindow.fromWebContents(e.sender));
    const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openFiles', async (e, opts = {}) => {
    // Electron's dialogs take a missing window as no parent
    const w = /** @type {Electron.BaseWindow} */ (BrowserWindow.fromWebContents(e.sender));
    const r = await dialog.showOpenDialog(w, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: opts.defaultPath,
      filters: opts.images ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] : undefined,
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openIn', async (_e, target, p) => {
    const apps = { vscode: 'Visual Studio Code', cursor: 'Cursor', terminal: 'Terminal', iterm: 'iTerm', xcode: 'Xcode', zed: 'Zed' };
    if (target === 'finder') return shell.openPath(p);
    if (isWin) return openInWindows(target, p);
    if (linux) return linux.open(target, p);
    return run('open', ['-a', apps[target] || target, p]);
  });
  ipcMain.handle('clipboard:write', (_e, t) => clipboard.writeText(t));
  ipcMain.handle('window:open', (_e, hash) => {
    createWindow(hash);
  });
  ipcMain.handle('window:mini', () => toggleMini());
  ipcMain.handle('app:setTray', (_e, on) => setTray(on));
  ipcMain.handle('mini:shortcut', (_e, on) => setMiniShortcut(on));
  ipcMain.handle('voice:hotkey', (_e, acc) => setVoiceHotkey(acc));
  /* App icons for the "open in" pickers. */
  const APP_PATHS = isWin
    ? WIN_APP_PATHS
    : {
        finder: '/System/Library/CoreServices/Finder.app',
        vscode: '/Applications/Visual Studio Code.app',
        cursor: '/Applications/Cursor.app',
        zed: '/Applications/Zed.app',
        terminal: '/System/Applications/Utilities/Terminal.app',
        iterm: '/Applications/iTerm.app',
        xcode: '/Applications/Xcode.app',
      };
  ipcMain.handle('app:icon', async (_e, id) => {
    const p = linux ? linux.paths()[id] : APP_PATHS[id];
    if (!p || !fs.existsSync(p)) return null;
    try {
      return (await app.getFileIcon(p, { size: 'normal' })).toDataURL();
    } catch (error) {
      // the menu shows the app without its icon
      noteIgnored(`read the icon of ${id}`, error);
      return null;
    }
  });
  ipcMain.handle('app:installed', () =>
    linux ? linux.installed() : Object.fromEntries(Object.entries(APP_PATHS).map(([k, p]) => [k, isWin ? winExists(p) : fs.existsSync(p)])),
  );
  ipcMain.handle('window:isFocused', (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? true);
  ipcMain.handle('window:titleBarOverlay', (e, color, symbolColor) => {
    if (!isWin) return;
    try {
      // as tall as the zoomed title bar under them (app/zoom.cjs)
      const height = zoom.titleBarHeight(e.sender.getZoomFactor());
      BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay({ color: String(color), symbolColor: String(symbolColor), height });
    } catch (error) {
      // the window may be closing
      noteIgnored("color the window's title bar buttons", error);
    }
  });
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  nativeTheme.on('updated', () => {
    for (const w of windows) w.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
  });
}

module.exports = { register };

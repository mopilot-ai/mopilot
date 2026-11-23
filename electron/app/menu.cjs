// The application menu, the menu bar (tray) icon, and the global shortcuts (Quick Chat, voice).
const path = require('node:path');
const { nativeShortcutAccelerator, toAccelerator } = require('../../shared/shortcutKeys.mjs');
const { SHORTCUT_ACTIONS, effectiveBindings, nativeRoleBindings, resolveShortcut } = require('../../shared/shortcuts.mjs');
const { HARNESS_DOCS } = require('../../shared/harnessDocs.mjs');
const { COMMUNITY_URL } = require('../../shared/community.mjs');
const { trayTooltip } = require('../capabilities/computerUse.cjs');
const { noteIgnored } = require('../ignored.cjs');
const historyIndicator = require('../computerHistory/indicator.cjs');
const historyTray = require('../computerHistory/tray.cjs');
const { appComputerHistory } = require('../computerHistory/service.cjs');
const { createProfileAction } = require('../perf/cpuProfileAction.cjs');
const { englishText } = require('./language.cjs');

/**
 * @param {import('../main.cjs').MenusDeps & { notice: Parameters<typeof createProfileAction>[0]['notice'], native?: Parameters<typeof createProfileAction>[0]['native'], t?: typeof englishText }} deps what main.cjs passes in (`notice`: an OS notification through electron/platform/notify.cjs; `native`: the Electron modules the profile item uses, replaced in tests; `t`: a label in the interface's language, electron/app/language.cjs); `live` reads main's late-bound updater, Codex adapter and computer use
 */
function createMenus({
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  shell,
  BrowserWindow,
  APP_NAME,
  isDev,
  isWin,
  win,
  live,
  notice,
  native,
  t = englishText,
}) {
  const { windows, mainWindow, createWindow, showMainWindow, commandMainWindow, toggleMini } = win;
  /** A command from the app's menus or tray, to the focused app window; with none open, one opens for it. */
  let directAction = true;
  function sendCmd(cmd, ...args) {
    const id = cmd === 'new-temp-chat' ? 'temporary-chat' : cmd;
    const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
    if (action)
      return sendCmd('shortcut', {
        id,
        ...(!directAction ? { combo: effectiveBindings(action, menuKeybindings, process.platform)[0] } : {}),
      });
    const focused = BrowserWindow.getFocusedWindow();
    const w = focused && windows.has(focused) ? focused : mainWindow();
    if (w) return w.webContents.send('app:command', cmd, ...args);
    commandMainWindow(cmd, ...args).catch((error) => noteIgnored(`open the app for ${cmd}`, error));
  }

  /** Help > Capture Performance Profile: 10 s of the focused window's renderer (electron/perf/cpuProfileAction.cjs). */
  const captureProfile = createProfileAction({
    shell,
    appName: APP_NAME,
    ignored: noteIgnored,
    notice,
    native,
    pickWindow: () => {
      const focused = BrowserWindow.getFocusedWindow();
      return focused && windows.has(focused) ? focused : mainWindow();
    },
  });

  let menuKeybindings = {};
  /**
   * A menu template entry whose submenu is a template (not a built Menu), so it can be edited.
   * @typedef {Omit<Electron.MenuItemConstructorOptions, 'submenu'> & { submenu?: Electron.MenuItemConstructorOptions[] }} MenuTemplateItem
   */
  function buildMenu() {
    const used = new Set();
    const acc = (id) => {
      used.add(id);
      const action = /** @type {import('../../shared/shortcuts.mjs').ShortcutAction} */ (SHORTCUT_ACTIONS.find((a) => a.id === id));
      const key = effectiveBindings(action, menuKeybindings, process.platform)[0];
      return key && resolveShortcut(key, menuKeybindings, 'app', process.platform)?.id === id
        ? (nativeShortcutAccelerator(key, process.platform) ?? undefined)
        : undefined;
    };
    /** @type {MenuTemplateItem[]} */
    const template = [
      {
        label: APP_NAME,
        submenu: [
          { label: t('About {0}', [APP_NAME]), click: () => sendCmd('about') },
          { label: t('Check for Updates…'), click: () => (live.updater?.check({ manual: true }), sendCmd('about')) },
          { type: 'separator' },
          { label: t('Settings…'), accelerator: acc('settings'), click: () => sendCmd('settings') },
          { type: 'separator' },
          { label: t('Log Out'), click: () => sendCmd('logout') },
          { type: 'separator' },
          { role: 'services', label: t('Services') },
          { type: 'separator' },
          { role: 'hide', label: t('Hide {0}', [APP_NAME]) },
          { role: 'hideOthers', label: t('Hide Others') },
          { role: 'unhide', label: t('Show All') },
          { type: 'separator' },
          { role: 'quit', label: t('Quit {0}', [APP_NAME]) },
        ],
      },
      {
        label: t('File'),
        submenu: [
          { label: t('New Chat'), accelerator: acc('new-chat'), click: () => sendCmd('new-chat') },
          { label: t('New Standalone Chat'), accelerator: acc('new-standalone'), click: () => sendCmd('new-standalone') },
          { label: t('Quick Chat'), accelerator: acc('quick-chat'), click: () => sendCmd('quick-chat') },
          { label: t('New Temporary Chat'), accelerator: acc('temporary-chat'), click: () => sendCmd('new-temp-chat') },
          { label: t('New Window'), click: () => createWindow() },
          { label: t('Open Folder…'), accelerator: acc('open-folder'), click: () => sendCmd('open-folder') },
          { label: t('Open Browser Tab'), accelerator: acc('open-browser-tab'), click: () => sendCmd('open-browser-tab') },
          { type: 'separator' },
          { label: t('Copy Working Directory'), accelerator: acc('copy-cwd'), click: () => sendCmd('copy-cwd') },
          { type: 'separator' },
          { label: t('Close Tab or Window'), accelerator: acc('close-tab'), click: () => sendCmd('close-tab') },
        ],
      },
      {
        label: t('Edit'),
        submenu: [
          { role: 'undo', label: t('Undo') },
          { role: 'redo', label: t('Redo') },
          { type: 'separator' },
          { role: 'cut', label: t('Cut') },
          { role: 'copy', label: t('Copy') },
          { role: 'paste', label: t('Paste') },
          { role: 'pasteAndMatchStyle', label: t('Paste and Match Style') },
          { role: 'delete', label: t('Delete') },
          { role: 'selectAll', label: t('Select All') },
          { type: 'separator' },
          // no accelerator: ⌘F is the app's only while its own UI has focus (shared/shortcuts.mjs appFocus), and a
          // menu key would take it from a browser page or a terminal too
          { label: t('Find in Chat'), click: () => sendCmd('find-in-chat') },
        ],
      },
      {
        label: t('View'),
        submenu: [
          { label: t('Toggle Sidebar'), accelerator: acc('toggle-sidebar'), click: () => sendCmd('toggle-sidebar') },
          {
            label: t('Toggle Bottom Panel'),
            accelerator: acc('toggle-bottom-panel'),
            click: () => sendCmd('toggle-bottom-panel'),
          },
          { label: t('Open Terminal'), accelerator: acc('open-terminal'), click: () => sendCmd('open-terminal') },
          { label: t('Toggle Changes Panel'), accelerator: acc('toggle-changes'), click: () => sendCmd('toggle-changes') },
          { label: t('Open Changes Tab'), accelerator: acc('open-changes'), click: () => sendCmd('open-changes') },
          { label: t('Toggle Navigation Panel'), accelerator: acc('toggle-files'), click: () => sendCmd('toggle-files') },
          { label: t('Toggle Pinned Summary'), click: () => sendCmd('toggle-summary') },
          { type: 'separator' },
          { label: t('Command Menu…'), accelerator: acc('command-menu'), click: () => sendCmd('command-menu') },
          { label: t('Search Chats…'), accelerator: acc('search'), click: () => sendCmd('search') },
          { label: t('Search Files'), accelerator: acc('search-files'), click: () => sendCmd('search-files') },
          {
            label: t('Toggle Activity View'),
            accelerator: acc('toggle-activity'),
            click: () => sendCmd('toggle-activity'),
          },
          {
            label: t('Next Chat Needing Attention'),
            accelerator: acc('next-attention'),
            click: () => sendCmd('next-attention'),
          },
          { label: t('Clear All Unreads'), accelerator: acc('clear-unreads'), click: () => sendCmd('clear-unreads') },
          { type: 'separator' },
          { label: t('Previous Chat'), accelerator: acc('prev-chat'), click: () => sendCmd('prev-chat') },
          { label: t('Next Chat'), accelerator: acc('next-chat'), click: () => sendCmd('next-chat') },
          { label: t('Close Split View'), accelerator: acc('close-split'), click: () => sendCmd('close-split') },
          { label: t('Back'), accelerator: acc('back'), click: () => sendCmd('back') },
          { label: t('Forward'), accelerator: acc('forward'), click: () => sendCmd('forward') },
          { type: 'separator' },
          // the whole window's zoom, as Claude Desktop's View menu (shared/zoom.mjs)
          { label: t('Actual Size'), accelerator: acc('font-reset'), click: () => sendCmd('font-reset') },
          { label: t('Zoom In'), accelerator: acc('font-increase'), click: () => sendCmd('font-increase') },
          { label: t('Zoom Out'), accelerator: acc('font-decrease'), click: () => sendCmd('font-decrease') },
          { type: 'separator' },
          { role: 'togglefullscreen', label: t('Toggle Full Screen') },
          ...(isDev
            ? /** @type {Electron.MenuItemConstructorOptions[]} */ ([{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }])
            : []),
        ],
      },
      {
        role: 'windowMenu',
        label: t('Window'),
        submenu: [
          { role: 'minimize', label: t('Minimize') },
          { role: 'zoom', label: t('Zoom') },
          { type: 'separator' },
          { role: 'front', label: t('Bring All to Front') },
        ],
      },
      {
        role: 'help',
        label: t('Help'),
        submenu: [
          ...HARNESS_DOCS.map((d) => ({ label: t('{0} Documentation', [d.name]), click: () => shell.openExternal(d.url) })),
          { label: t('Join the Community'), click: () => shell.openExternal(COMMUNITY_URL) },
          { label: t('Keyboard Shortcuts'), accelerator: acc('shortcuts'), click: () => sendCmd('shortcuts') },
          { type: 'separator' },
          // the focused window's bug report, about the chat it shows (src/lib/appShortcuts.ts)
          { label: t('Report a Bug…'), click: () => sendCmd('report-bug') },
          { label: t('Capture Performance Profile…'), click: () => captureProfile() },
        ],
      },
    ];
    // Native accelerators also work when an embedded page owns keyboard focus.
    // Secondary bindings share the same command and never add a renderer dispatch path.
    const extras = [];
    for (const action of SHORTCUT_ACTIONS) {
      if (!action.menu) continue;
      const keys = effectiveBindings(action, menuKeybindings, process.platform);
      for (const key of keys.slice(used.has(action.id) ? 1 : 0)) {
        const accelerator =
          resolveShortcut(key, menuKeybindings, 'app', process.platform)?.id === action.id &&
          nativeShortcutAccelerator(key, process.platform);
        if (accelerator)
          extras.push({
            label: action.title,
            visible: false,
            acceleratorWorksWhenHidden: true,
            accelerator,
            click: () => sendCmd('shortcut', { id: action.id, combo: key }),
          });
      }
    }
    const editMenu = template[2].submenu;
    if (Array.isArray(editMenu)) editMenu.push(...extras);
    if (isWin) {
      // No app menu on Windows: Settings and Exit go to File, About and updates to Help. The window
      // shows no menu bar (titleBarStyle 'hidden'), but the accelerators still work.
      template.shift();
      // the template above always has these menus, each with a list of items
      const submenuOf = (pick) =>
        /** @type {Electron.MenuItemConstructorOptions[]} */ (
          /** @type {Electron.MenuItemConstructorOptions} */ (template.find(pick)).submenu
        );
      const file = submenuOf((m) => m.label === t('File'));
      file.splice(
        file.length - 1,
        1,
        { label: t('Settings…'), accelerator: acc('settings'), click: () => sendCmd('settings') },
        { type: 'separator' },
        { label: t('Close Tab or Window'), accelerator: acc('close-tab'), click: () => sendCmd('close-tab') },
        { role: 'quit', label: t('Exit') },
      );
      submenuOf((m) => m.role === 'help').push(
        { type: 'separator' },
        { label: t('Check for Updates…'), click: () => (live.updater?.check({ manual: true }), sendCmd('about')) },
        { label: t('About {0}', [APP_NAME]), click: () => sendCmd('about') },
      );
      // pasteAndMatchStyle (Ctrl+Shift+V) is a macOS idea
      const edit = /** @type {Electron.MenuItemConstructorOptions} */ (template.find((m) => m.label === t('Edit')));
      edit.submenu = submenuOf((m) => m.label === t('Edit')).filter((i) => i.role !== 'pasteAndMatchStyle');
    }
    // A legacy customization owns the app key; native editing keeps DOM/Chromium ownership.
    const customized = Object.values(menuKeybindings);
    const roles = nativeRoleBindings(process.platform);
    const suppress = (items) => {
      for (const item of items) {
        if (item.click) {
          const click = item.click;
          item.click = (menuItem, window, event) => {
            directAction = !event?.triggeredByAccelerator;
            try {
              return click(menuItem, window, event);
            } finally {
              directAction = true;
            }
          };
        }
        if (item.role && roles[item.role])
          item.accelerator = customized.includes(roles[item.role]) ? null : toAccelerator(roles[item.role]);
        if (Array.isArray(item.submenu)) suppress(item.submenu);
      }
    };
    suppress(template);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    // the menu-bar item has labels of its own, which a new language renames too
    if (tray) syncTray();
  }

  /* Menu bar (tray) icon: keeps the app reachable when the window is closed. While an agent controls
     the Mac, or Computer History is on, it is there whatever the setting, with "Stop controlling your Mac"
     and Computer History's Pause or Resume on top. */
  /** @type {InstanceType<typeof Tray> | null} */
  let tray = null;
  let trayPref = false;
  /** the chat controlling the Mac, if any */
  /** @type {string | null} */
  let controllingChat = null;
  function setTray(on) {
    trayPref = !!on;
    syncTray();
  }
  let history = historyIndicator.get().status;
  historyIndicator.subscribe((s) => {
    history = s.status;
    syncTray();
  });
  function syncTray() {
    if (!trayPref && !controllingChat && !historyTray.shows(history) && !live.alwaysOn?.active) {
      tray?.destroy();
      tray = null;
      return;
    }
    let item = tray;
    if (!item) {
      // macOS takes a template image (tinted by the menu bar); Windows the colored icon, in every DPI's size
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', isWin ? 'tray.ico' : 'trayTemplate.png'));
      item = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
      tray = item;
      if (icon.isEmpty() && !isWin) item.setTitle(APP_NAME);
      // Windows opens the menu on right-click; a left click brings the window back
      if (isWin) item.on('click', () => void showMainWindow());
    }
    item.setToolTip(controllingChat ? trayTooltip(live.codex?.chatName(controllingChat)) : (historyTray.LABEL[history] ?? APP_NAME));
    const show = () => void showMainWindow();
    // Keep app actions first, with inspectable phone details in their own group.
    const alwaysOn = live.alwaysOn?.active ? live.alwaysOn : null;
    item.setContextMenu(
      Menu.buildFromTemplate([
        ...(controllingChat
          ? /** @type {Electron.MenuItemConstructorOptions[]} */ ([
              { label: t('Stop computer use'), click: () => live.computerUse?.cu.stop() },
              { type: 'separator' },
            ])
          : []),
        ...historyTray.trayItems(history, {
          pause: () => appComputerHistory()?.act((r) => r.pause()),
          resume: () => appComputerHistory()?.act((r) => r.resume()),
          manage: () =>
            void commandMainWindow('settings', 'computer-history').catch((error) =>
              noteIgnored('open Computer History from the tray', error),
            ),
        }),
        { label: alwaysOn ? t('Open {0}', [APP_NAME]) : t('Show {0}', [APP_NAME]), click: show },
        {
          label: t('New Chat'),
          click: () => void commandMainWindow('new-chat-default').catch((error) => noteIgnored('open a new chat from the tray', error)),
        },
        { label: t('Open Quick Chat'), click: () => toggleMini() },
        { type: 'separator' },
        ...(alwaysOn
          ? alwaysOn.trayItems(
              () =>
                void commandMainWindow('settings', 'connections').catch((error) =>
                  noteIgnored('open the phone settings from the tray', error),
                ),
            )
          : []),
        { role: 'quit', label: t('Quit {0}', [APP_NAME]) },
      ]),
    );
  }

  let voiceHotkey = null;
  function setVoiceHotkey(acc) {
    try {
      if (voiceHotkey) globalShortcut.unregister(voiceHotkey);
      voiceHotkey = null;
      if (!acc) return true;
      const ok = globalShortcut.register(
        acc,
        () => void commandMainWindow('start-voice').catch((error) => noteIgnored('start voice from its hotkey', error)),
      );
      if (ok) voiceHotkey = acc;
      return ok;
    } catch (error) {
      // an accelerator Electron can't parse: reported as false
      noteIgnored('register the dictation shortcut', error);
      return false;
    }
  }

  function setMiniShortcut(on) {
    try {
      if (globalShortcut.isRegistered('Alt+Space')) globalShortcut.unregister('Alt+Space');
      if (on) return globalShortcut.register('Alt+Space', toggleMini);
    } catch (error) {
      // registration failed (e.g. the key is taken): reported as false below
      noteIgnored('register the Quick Chat shortcut', error);
    }
    return false;
  }

  /** The chat controlling the Mac changed (computer use): the tray shows it, with a way to stop. */
  function setControlling(chatId) {
    if (chatId === controllingChat) return;
    controllingChat = chatId;
    syncTray();
  }

  return {
    sendCmd,
    buildMenu,
    get menuKeybindings() {
      return menuKeybindings;
    },
    set menuKeybindings(v) {
      menuKeybindings = v;
    },
    setTray,
    refreshTray: syncTray,
    setControlling,
    /** @returns {Electron.Tray | null} */
    get tray() {
      return tray;
    },
    setVoiceHotkey,
    setMiniShortcut,
  };
}

module.exports = { createMenus };

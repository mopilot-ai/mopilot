// The app's windows: the main windows and Quick Chat, their navigation guard, which chat each shows, and sending events to them.
const { chatShownIn, shownBy } = require('../session/viewing.cjs');
const { blockAppShortcutInput } = require('../capabilities/browser/browserShortcuts.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { defaultPalette } = require('../../shared/defaultPalette.mjs');
const { countBroadcast, countIpc, countRaw } = require('../perf/probe.cjs');
const { wakeWatcher } = require('../platform/processTree.cjs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { CoreBatcher, namedChats, familyChats } = require('../harness/coreBatcher.cjs');
const { hostOfChat } = require('../host/wiring.cjs');
const { acpSender } = require('../harness/items/acp.cjs');
const { claudeSender } = require('../harness/items/claude.cjs');
const { windowSends } = require('./streamBatch.cjs');
const { markStartup } = require('../perf/startup.cjs');
const { createWindowRecovery } = require('../platform/windowRecovery.cjs');
const { appMenus } = require('./contextMenu.cjs');

const APP_PAGE = path.join(__dirname, '..', '..', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload.cjs');
const isMac = process.platform === 'darwin';
/** Broadcasts about chats as a whole: every chat's pending text goes out before them. */
const CHAT_WIDE = new Set(['chats:deleted', 'chats:reset']);

/**
 * @param {import('../main.cjs').WindowsDeps & { contextMenus?: typeof appMenus }} deps what main.cjs passes in; `live`
 *   reads main's late-bound computer use; `contextMenus` (a test's stand-in) gives each window its right-click menus
 */
function createWindows({
  BrowserWindow,
  webContents,
  shell,
  nativeTheme,
  screen,
  APP_NAME,
  isDev,
  isWin,
  windowReadiness,
  live,
  zoom,
  contextMenus = appMenus,
}) {
  /** @type {Set<Electron.BrowserWindow>} */
  const windows = new Set();
  const recovery = createWindowRecovery({ page: APP_PAGE, isDev, telemetry: () => live.telemetry, quitting: () => quitting });
  /**
   * Send a push event to every open window, after the stream deltas still pending for the chat it names (a chat's state
   * never overtakes its text; other chats keep their own cadence, so a broadcast never defeats the coalescing).
   */
  function broadcastAll(channel, ...args) {
    // a deletion receipt names native keys, not a chat id, and a reset replaces every chat: nothing may follow them
    if (CHAT_WIDE.has(channel)) streams.flushAll();
    else streams.flushNamed(namedChats(args));
    // an adapter's event broadcast on its channel counts as one it emitted (the adapters' own count where they enter the batcher)
    countBroadcast(channel, args[0]);
    for (const w of windows) if (!w.isDestroyed()) countIpc(channel, w.webContents.id), w.webContents.send(channel, ...args);
  }
  /**
   * Send a push event about a chat (the payload's chatId) to the windows that show it, and to those that have not reported
   * a view yet (they may show it). Other windows would drop it: a live view of a chat they do not show is read from the chat when opened.
   */
  function sendToViewers(channel, payload) {
    const chatId = payload.chatId;
    streams.flushNamed([chatId]);
    for (const w of windows) {
      if (w.isDestroyed()) continue;
      const id = w.webContents.id;
      if (viewedBy.has(id) && !windowShows(id, chatId)) continue;
      countIpc(channel, id);
      w.webContents.send(channel, payload);
    }
  }
  /** A turn's diff: a running one only to the windows showing the chat, the final one (and taking one back) to every window. */
  const publish = (d, live) => (live ? sendToViewers : broadcastAll)('session:turnDiff', d);
  const turnDiffSink = { publish, shows: (chatId) => chatShown(chatId) };
  function broadcastExcept(channel, sender, payload) {
    streams.flushNamed(namedChats([payload]));
    for (const w of windows) if (!w.isDestroyed() && w.webContents !== sender) w.webContents.send(channel, payload);
  }

  /** The app's own page (any hash or query): the dev server in dev, dist/index.html otherwise. */
  function isAppPage(url) {
    try {
      // isDev means VITE_DEV_SERVER_URL is set
      if (isDev) return new URL(url).origin === new URL(/** @type {string} */ (process.env.VITE_DEV_SERVER_URL)).origin;
      if (!url.startsWith('file:')) return false;
      const a = path.resolve(fileURLToPath(url.replace(/[?#].*$/, '')));
      return isWin ? a.toLowerCase() === path.resolve(APP_PAGE).toLowerCase() : a === path.resolve(APP_PAGE);
    } catch {
      return false;
    }
  }
  /**
   * A window with the preload only ever shows the app's own page: anything else (a dropped .html file,
   * a link) would get the whole native bridge. Web and mail links open in the browser; nothing else opens.
   */
  function guardNavigation(wc) {
    blockAppShortcutInput(wc, () => live.menuKeybindings);
    // a link that can't open (no browser; a pinned run's scratch Chrome refused or didn't start) opens nothing
    const external = (url) => {
      if (!/^(https?|mailto):/i.test(url)) return;
      void Promise.resolve()
        .then(() => shell.openExternal(url))
        .catch((error) => noteIgnored('open a link from an app window', error));
    };
    wc.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (isAppPage(url)) return;
      e.preventDefault();
      external(url);
    });
  }

  /** The chats each window's panes show (app:viewing), so a turn finishing in main knows whether someone is looking at it. */
  /**
   * A change to what a window shows first sends what is pending under the old view, so a delta goes to the windows
   * that showed its chat when it was queued and a window that starts showing a chat has all of its text.
   * @type {Map<number, import('../session/viewing.cjs').WindowView>}
   */
  const viewedBy = new (class extends Map {
    set(id, view) {
      if (!sameVisible(this.get(id), view)) streams.flushAll();
      return super.set(id, view);
    }
    delete(id) {
      if (this.has(id)) streams.flushAll();
      return super.delete(id);
    }
  })();
  const sameVisible = (a, b) => !!a && !!b && a.visible.length === b.visible.length && a.visible.every((c, i) => c === b.visible[i]);
  /**
   * Whether the window is on the slow lane for the chat: it reported a view (an empty one for Home or a page) that lacks
   * it. An id no chat record has (a sub-agent thread, a chat not yet aliased) is shown by whoever shows its parent, which
   * a view cannot say, so it never is background.
   */
  const inBackground = (wcId, chat) => viewedBy.has(wcId) && isChat(chat) && !windowShows(wcId, chat);
  const isChat = (chat) => {
    try {
      return !!live.chats?.get(chat);
    } catch (error) {
      noteIgnored('read whether an id is a chat', error);
      return false;
    }
  };
  /** Whether a delta flush for `scope` (those windows not showing its chat, or the rest) is meant for the window. */
  const inScope = (w, scope) => !scope || inBackground(w.webContents.id, scope.chat) === scope.background;
  const chatInView = (chatId) => chatShownIn(viewedBy, webContents, chatId, (wc) => !!BrowserWindow.fromWebContents(wc)?.isFocused());
  /** A window that is still open shows the chat, focused or not. */
  const chatShown = (chatId) => chatShownIn(viewedBy, webContents, chatId);
  /** One window's panes show the chat (it may speak for it). */
  const windowShows = (wcId, chatId) => shownBy(viewedBy, wcId, chatId);

  /**
   * @param {string} [hash] the chat to open on (#thread=…)
   * @param {{ hidden?: boolean, inactive?: boolean, restore?: { visible: boolean, minimized: boolean } }} [opts] restore: after
   *   a restart nobody asked for, the window comes back as it was, without taking focus (shown inactive, minimized, or
   *   hidden); inactive: shown behind the current window (an agent's open_session_in), the focus left where it is
   */
  function createWindow(hash, { hidden = false, inactive = false, restore = undefined } = {}) {
    // the title bar's buttons start where the saved zoom puts them (app/zoom.cjs)
    const chrome = zoom.chromeOptions();
    const win = new BrowserWindow({
      width: 1710,
      height: 1010,
      minWidth: 760,
      minHeight: 520,
      title: APP_NAME,
      // Windows: no frame, with the system's caption buttons drawn over the top right (the renderer
      // keeps that corner clear and sends the theme's colors, see window:titleBarOverlay).
      ...(isWin
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: defaultPalette(nativeTheme.shouldUseDarkColors).bg,
              symbolColor: defaultPalette(nativeTheme.shouldUseDarkColors).fg,
              height: chrome.titleBarHeight,
            },
          }
        : { titleBarStyle: 'hiddenInset', trafficLightPosition: chrome.trafficLightPosition }),
      backgroundColor: defaultPalette(nativeTheme.shouldUseDarkColors).bg,
      vibrancy: undefined,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        webviewTag: true,
      },
    });
    windows.add(win);
    // Linux draws its own frame: nothing to place (setWindowButtonPosition is macOS's alone)
    zoom.attach(win, isWin ? 'overlay' : isMac ? 'buttons' : null);
    const windowId = win.webContents.id;
    win.webContents.on('did-start-loading', () => {
      windowReadiness.forget(windowId);
      // the page starts over (a reload): its next view report is a new view, whose chats count as opened again
      viewedBy.delete(windowId);
    });
    win.on('closed', () => {
      windows.delete(win);
      // what was pending for its chats goes to the windows still open now, not a tick later
      streams.flushAll();
      windowReadiness.forget(windowId, true);
      viewedBy.delete(windowId);
    });
    if (process.env.SAGE_BOUNDS) {
      const [x, y, width, height] = process.env.SAGE_BOUNDS.split(',').map(Number);
      win.setBounds({ x, y, width, height });
    }
    // a window coming back on screen takes what its chats' slow queues hold now
    win.on('show', () => streams.flushAll());
    win.on('restore', () => streams.flushAll());
    const sendFocus = () => !win.isDestroyed() && win.webContents.send('window:focus', win.isFocused());
    win.on('focus', () => {
      sendFocus();
      // focusing a window counts as opening the chats its panes show: one paused for a computer-use grant gets its card now
      for (const chatId of viewedBy.get(windowId)?.visible ?? []) {
        live.computerUse?.onViewed(chatId);
        // and gets its harness's process ready, as on a new view (#1830)
        live.warmOnOpen?.viewed(chatId);
      }
    });
    win.on('blur', sendFocus);
    win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
    win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));

    guardNavigation(win.webContents);
    contextMenus.attach(win.webContents);
    recovery.attach(win, 'main', hash);
    // Reveal the native window before first paint; launch.ts keeps unready services behind app:ready.
    // No later paint callback or fallback timer may undo a user's hide/minimize or a confirmed quit.
    if (restore) {
      // the launch itself (LaunchServices' activate) must not bring it forward and take focus
      restoredAt = Date.now();
      if (restore.minimized) win.minimize();
      else if (restore.visible) win.showInactive();
    } else if (!hidden) {
      if (inactive) win.showInactive();
      else win.show();
    }
    // the first window a launch shows, on the startup timeline (electron/perf/startup.cjs)
    if (win.isVisible()) markStartup('windowShown');
    return win;
  }

  /* Quick Chat: a floating view of ordinary saved chats (⌥Space). */
  /** @type {InstanceType<typeof BrowserWindow> | null} */
  let mini = null;
  function mainWindow() {
    return [...windows].find((w) => w !== mini && !w.isDestroyed()) || null;
  }
  /** The app window brought forward (never Quick Chat): a hidden or minimized one shows; with none, one opens. */
  /** Set by hideAll: the quit is confirmed, so nothing (a second launch, a notification click) shows a window again. */
  let quitting = false;
  /** When a stealth restart's window was restored (createWindow's restore): the launch's own activate comes soon after. */
  let restoredAt = 0;
  const RESTORE_SETTLE_MS = 3000;
  function showMainWindow() {
    const w = mainWindow() || createWindow(undefined, { hidden: quitting });
    if (quitting || Date.now() - restoredAt < RESTORE_SETTLE_MS) return w;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return w;
  }
  /**
   * An app:command for the app window, sent once its page listens: a window opened for it (none was open, say
   * after a notification click) would drop a command sent before it booted.
   */
  async function commandMainWindow(cmd, ...args) {
    const w = showMainWindow();
    await windowReadiness.wait(w.webContents.id);
    if (!w.isDestroyed()) w.webContents.send('app:command', cmd, ...args);
  }
  async function readyMainWindow() {
    const w = mainWindow() || createWindow(undefined, { hidden: true });
    await windowReadiness.wait(w.webContents.id);
    if (w.isDestroyed()) throw new Error('The app window was closed');
    return w;
  }
  function toggleMini() {
    if (!mainWindow()) createWindow(undefined, { hidden: true });
    if (mini && !mini.isDestroyed()) {
      if (mini.isVisible() && mini.isFocused()) mini.hide();
      else {
        mini.show();
        mini.focus();
        mini.webContents.send('mini:shown');
      }
      return;
    }
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const quickWindow = new BrowserWindow({
      width: Math.min(640, workArea.width),
      height: Math.min(480, workArea.height),
      minWidth: Math.min(400, workArea.width),
      minHeight: Math.min(300, workArea.height),
      maxWidth: workArea.width,
      maxHeight: workArea.height,
      x: Math.round(workArea.x + (workArea.width - Math.min(640, workArea.width)) / 2),
      y: Math.round(workArea.y + Math.max(0, Math.min(workArea.height * 0.15, workArea.height - 480))),
      // One opaque window: the system draws its rounded corners and shadow. A transparent window
      // drew its own frame inside the system's, so Quick Chat showed two nested frames.
      frame: false,
      backgroundColor: defaultPalette(nativeTheme.shouldUseDarkColors).bg,
      // a click on a header button acts even before the floating window has become key
      acceptFirstMouse: true,
      resizable: true,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      hasShadow: true,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false, spellcheck: false },
    });
    mini = quickWindow;
    windows.add(quickWindow);
    zoom.attach(quickWindow, null);
    quickWindow.on('blur', () => mini && !mini.isDestroyed() && mini.hide());
    quickWindow.on('closed', () => {
      windows.delete(quickWindow);
      mini = null;
    });
    quickWindow.once('ready-to-show', () => {
      quickWindow.show();
      quickWindow.focus();
    });
    guardNavigation(quickWindow.webContents);
    contextMenus.attach(quickWindow.webContents);
    recovery.attach(quickWindow, 'quick', 'mini');
  }

  /** Windows that registered with the controller (session:ready); events about a message go to the one it came from. */
  /** @type {Set<Electron.WebContents>} */
  const execWindows = new Set();
  /** Events that draw the message in the window it came from; Quick Chat gets them for its own sends, other events stay with the step windows. */
  const DISPLAY_EVENTS = new Set(['turnStarting', 'steered']);
  /** The main windows, the one a message came from first. */
  function stepWindows(origin) {
    const live = [...execWindows].filter((wc) => !wc.isDestroyed() && (!mini || mini.isDestroyed() || wc !== mini.webContents));
    const first = live.find((x) => x.id === origin);
    return first ? [first, ...live.filter((x) => x !== first)] : live;
  }
  /**
   * An item event from the Codex adapter: to every window (each learns whether it sent the message,
   * `mine`), or with a target to the window the message came from ('any': whichever main window).
   * Returns whether a window got it.
   */
  function sendCodex(event, target, scope) {
    if (target === undefined) {
      let sent = false;
      for (const w of windows)
        if (!w.isDestroyed() && inScope(w, scope))
          send(w.webContents, 'codex:item', event, { mine: event.origin != null && w.webContents.id === event.origin }), (sent = true);
      return sent;
    }
    const wc = stepWindows(target === 'any' ? null : target)[0] ?? [...windows].find((w) => !w.isDestroyed() && w !== mini)?.webContents;
    if (wc) send(wc, 'codex:item', event, { mine: true });
    return !!wc;
  }
  /**
   * An event from an adapter in main to windows, on that harness's channel: to all when no target is
   * given, else to the window the message came from ('any': whichever main window; 'shown': every app
   * window on screen, for an offer someone has to see). Returns whether a window got it.
   */
  function sendToWindows(channel, event, target, scope) {
    if (target === 'shown') {
      // Quick Chat, and an app window kept hidden for it, would take the event with nobody to see it
      const shown = [...windows].filter((w) => !w.isDestroyed() && w !== mini && w.isVisible());
      for (const w of shown) send(w.webContents, channel, event);
      return shown.length > 0;
    }
    if (target === undefined) {
      let sent = false;
      for (const w of windows) if (!w.isDestroyed() && inScope(w, scope)) send(w.webContents, channel, event), (sent = true);
      return sent;
    }
    const wc = stepWindows(target === 'any' ? null : target)[0] ?? [...windows].find((w) => !w.isDestroyed() && w !== mini)?.webContents;
    // the message's own display (#2316): Quick Chat is no step window, but it sent the message and shows it itself
    const quick =
      DISPLAY_EVENTS.has(event?.kind) && mini && !mini.isDestroyed() && target === mini.webContents.id ? mini.webContents : null;
    if (quick) send(quick, channel, event);
    if (!wc) return !!quick;
    send(wc, channel, event);
    return true;
  }
  /** Adapter events to one window each, joined into one stream batch per window while a batcher flush runs. */
  const { batch: batchSends, send } = windowSends();
  const acp = acpSender(live, sendToWindows, (chatId) => streams.flushChat(chatId));
  const claude = claudeSender(live, sendToWindows);
  /** How each family's events reach windows; Codex's also tell each window whether the message was its own. */
  // each sender takes the envelope ({ hostId }) as its last argument and ignores it for now (2.3 reads it)
  const SENDERS = {
    codex: sendCodex,
    claude: claude.send,
    acp: acp.send,
  };
  /** Every family's events pass the stream batcher on the way (electron/harness/coreBatcher.cjs, core/crates/batcher). */
  const streams = new CoreBatcher({
    // every event carries its chat's hostId: the Host that runs the chat (electron/host/wiring.cjs)
    hostOf: (chat) => hostOfChat(live, chat),
    // a request or broadcast names a session key or thread id as often as a chat id
    resolve: (key) => live.controller?.chatOf(key) ?? key,
    batch: batchSends,
    send: (family, event, target, scope, envelope) => SENDERS[family](event, target, scope, envelope),
    // a window whose view is known and lacks the chat gets its deltas on the slow tick (the others on the frame tick)
    hasBackground: (chat) => {
      for (const w of windows) if (!w.isDestroyed() && inBackground(w.webContents.id, chat)) return true;
      return false;
    },
    // a frame while an app window is on screen, focused or not; the background rate when every one is hidden
    watched: () => [...windows].some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()),
  });
  // a session's events belong to the chat the controller maps it to, so a switch's segments share the chat's queue
  const chats = familyChats({ chatOf: (key) => live.controller?.chatOf(key) ?? key });
  for (const [family, chatOf] of Object.entries(chats)) streams.register(family, chatOf);
  /**
   * An adapter event into the batcher, counted by the performance probe before anything batches it. A harness that
   * emits is active: the watch of what it starts goes back to recording soon (platform/processTree.cjs).
   */
  const push = (family, event, target) => (countRaw(family, event), wakeWatcher(), streams.push(family, event, target));
  const codexEmit = (event, target) => push('codex', event, target);
  const FAMILY_OF = new Map([
    ['claude:event', 'claude'],
    ['acp:event', 'acp'],
  ]);
  /** An event on a harness channel (through the batcher), or on any other channel to the windows after what is pending. */
  function emitToWindows(channel, event, target) {
    const family = FAMILY_OF.get(channel);
    if (family) return push(family, event, target);
    streams.flushNamed(namedChats([event]));
    return sendToWindows(channel, event, target);
  }
  const claudeEmit = (event, target) => emitToWindows('claude:event', event, target);
  const acpEmit = (event, target) => emitToWindows('acp:event', event, target);

  /** A confirmed quit: every window goes at once, while the cleanup after it still runs (up to QUIT_CLEANUP_MS). */
  /** One of the app's windows has focus: any window, the in-app browser's sign-in popups included. */
  const anyFocused = () => !!BrowserWindow.getFocusedWindow();
  /** One of the app's windows is full screen. */
  const anyFullScreen = () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFullScreen());

  function hideAll() {
    quitting = true;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible()) w.hide();
  }

  return {
    acpItems: acp.items,
    claudePages: claude.pages,
    windows,
    hideAll,
    anyFocused,
    anyFullScreen,
    broadcastAll,
    sendToViewers,
    turnDiffSink,
    broadcastExcept,
    viewedBy,
    chatInView,
    chatShown,
    windowShows,
    createWindow,
    mainWindow,
    showMainWindow,
    commandMainWindow,
    readyMainWindow,
    toggleMini,
    /** @returns {Electron.BrowserWindow | null} */
    get mini() {
      return mini;
    },
    execWindows,
    stepWindows,
    codexEmit,
    claudeEmit,
    acpEmit,
    emitToWindows,
    streams,
  };
}

module.exports = { createWindows };

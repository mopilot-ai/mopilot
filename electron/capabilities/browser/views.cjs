// The browser pane's tabs as main-owned WebContentsViews (shared.browser.viewTabs), for every harness: created in their storage partition, shown at the bounds a window's pane reports, parked in a hidden window otherwise so they keep loading and painting with no window open, and taking CDP input while their focus is emulated (focusForInput).
//
// - Main owns a tab's lifetime. A pane tab binds to its view by its pane id, or an agent's tab by its
//   chat and browser_* key (agentView). A window's pane reports where the page goes (a rect in CSS
//   pixels, scaled by the window's zoom) or null to hide it; the view is then added to that window's
//   contentView (reparented without reloading when another window shows it) or parked.
// - A user's tab remembers the chat whose pane opened it (chatOf), so what its page asks the user (web
//   permissions) goes on that chat's card instead of a native dialog.
// - Parked views live in one never-shown window. A view only removed from the view tree stops
//   drawing frames: CDP screenshots and requestAnimationFrame hang, while a parked one keeps both.
// - Chromium keeps a parked view's widget hidden although its page reports itself visible: a mouse or
//   key event sent over CDP hangs and lands nowhere, or is the first one dropped after the view wakes
//   (#1509). Every client that sends a view input emulates its focus first (focusForInput).
// - A page's zoom follows its view's width (pageZoom.cjs): put back when the view is shown or resized and on every
//   navigation, since Chromium keeps one zoom per host. The pane's Zoom In, Zoom Out and Actual Size set it per site.
// - The pane learns the page's state from main (browser:viewEvent): load and navigation events with a
//   snapshot of url, title, history and loading, failed loads, and Annotate's console signals.
// - A user's view goes when its pane tab closes (close) or every window that bound it is gone; an
//   agent's view (keep) stays until the agent or the user closes it.
const { wasDownload } = require('./downloadNavigations.cjs');
const { keyOf } = require('./pageKey.cjs');
const { stopLoading, STOP_LOADING } = require('./loadInterruption.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { isWebUrl } = require('../../../shared/browser.mjs');
const { restoreHistory } = require('./historyCopy.cjs');
const { PageZoom, hostOf, allowPinch } = require('./pageZoom.cjs');
const { webMcpPrefs } = require('./webmcp.cjs');
const { loadPanePage, cancelPaneLoad } = require('./viewLoad.cjs');

/** The webContents of every pane tab main created or adopted: the only views CDP and Annotate accept. */
const VIEW_TABS = new WeakSet();

/** Whether `wc` is a pane tab's page main created (or a popup it adopted as one). */
function isViewTab(wc) {
  return !!wc && typeof wc === 'object' && VIEW_TABS.has(keyOf(wc));
}

/** Whether CDP input to `wc` runs under emulated focus (focusForInput): a view tab, or any page with `always`. */
const emulatesFocus = (wc, always = false) => always || isViewTab(wc);

/** The CDP command that makes a page visible and focused to itself while its CDP session lasts. */
const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled';

/**
 * Before CDP input on `wc` (one CDP session; Chromium answers a repeat at once): a view tab, which no window may
 * show, or with `always` a page in another browser's window (the user's Chrome), gets emulated focus, so its first
 * mouse or key event lands (#1509). Detaching the session ends it, so the user's own use of the page is not
 * emulated. A pane <webview> guest is left to its window, which is asked to show it (hostViewport.cjs paint).
 * True when it asked.
 * @param {any} wc
 * @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} send the session's command
 * @param {boolean} [always]
 */
async function focusForInput(wc, send, always = false) {
  if (!emulatesFocus(wc, always)) return false;
  await send(FOCUS_EMULATION, { enabled: true });
  return true;
}

/**
 * A pane tab's page: no Node, isolated and sandboxed, web security on, no nested <webview>. Sub-frames run the
 * session's preloads too (MoPilot's page dialogs, pagePreload.cjs), which a sandbox gives no Node.
 */
const HARDENED = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInSubFrames: true,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
});
/** The size a page gets before any pane showed it, and the smallest parking window. */
const PARKED = Object.freeze({ width: 1280, height: 800 });
/** Pane ids whose view went, so a pane that binds one later drops its tab instead of reopening it. */
const CLOSED_MAX = 200;
/** Page events the pane mirrors as its <webview> did, with the page's state. */
const PAGE_EVENTS = [
  'did-start-loading',
  'did-stop-loading',
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
  'dom-ready',
  'focus',
];
/** The console messages the pane needs: Annotate's overlay signals (annotateOverlay.ts). */
const ANNOTATE_SIGNAL = 'mopilot-annotate:';

/** The pane's rect in CSS pixels as Electron lays a view out (DIPs at the window's zoom), or null for none. */
function scaleBounds(rect, zoom = 1) {
  const z = typeof zoom === 'number' && zoom > 0 ? zoom : 1;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const x = Math.round(n(rect?.x) * z);
  const y = Math.round(n(rect?.y) * z);
  const width = Math.round(n(rect?.width) * z);
  const height = Math.round(n(rect?.height) * z);
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

class PaneViews {
  /**
   * @param {{ WebContentsView: any, BrowserWindow: any,
   *           session: (partition: string) => any, partition: (requested: any) => string,
   *           windowOf: (sender: any) => any,
   *           agentView?: (chatId: string, tabKey: string | null) => any,
   *           onCreated?: (wc: any) => void, prepare?: (chat: string | null, url: string) => Promise<string> | null }} o
   *   session: Electron's session.fromPartition
   *   partition: the partition a new tab gets for the one asked for (storage.cjs)
   *   windowOf: the app window a pane's webContents belongs to, or null for anything else
   *   agentView: the page of a chat's browser_* tab (host.cjs), or null
   *   onCreated: installs the browser-only page policy (windows.cjs)
   */
  constructor(o) {
    this.o = o;
    /** webContents id -> entry */
    this.entries = new Map();
    /** pane id -> entry */
    this.panes = new Map();
    this.closed = new Set();
    /** the hidden window parked views live in */
    this.park = null;
    /** windows whose closing parks the views they show */
    this.watched = new WeakSet();
    /** pane webContents whose going releases their views */
    this.senders = new WeakSet();
    this.zoom = new PageZoom({ onRefit: (wc) => this.#refitPage(wc) });
  }

  /**
   * A new tab's view in `partition` (or `session`, a popup's opener's), loading `url` when given, or `history` instead
   * (an agent's duplicate, historyCopy.cjs). The tool that asked closes a copy whose history was not written.
   * @param {{ partition?: string, session?: any, url?: string, chat?: string | null, history?: { entries: any[], index: number } | null }} [o]
   */
  create({ partition, session, url = '', chat = null, history = null } = {}) {
    const ses = session ?? this.o.session(this.o.partition(partition));
    // an agent drives a page while no window shows it, so its timers and animation frames must not be throttled
    const view = new this.o.WebContentsView({
      webPreferences: { ...HARDENED, ...webMcpPrefs(), backgroundThrottling: false, session: ses },
    });
    // before anything reaches the page: one that loaded nothing answers no debugger command until it navigates, and
    // a load started meanwhile runs into the restore and can crash main (#1362)
    if (history) restoreHistory(view.webContents, history).catch((error) => noteIgnored('copy the history into a duplicate tab', error));
    const entry = this.#track(view);
    entry.chat = chat;
    if (url && !history)
      Promise.resolve(this.#load(entry, url)).catch((error) => {
        // a failed load reaches the pane as did-fail-load
        noteIgnored('load the first page of a new pane view', error);
      });
    return entry;
  }

  #load(entry, url, load = (url) => entry.wc.loadURL(url)) {
    const loading = loadPanePage(entry, url, this.o.prepare, load, (detail) => {
      this.#emit(entry, 'did-fail-load', detail);
      this.#emit(entry, 'did-stop-loading');
    });
    if (entry.previewLoad) this.#emit(entry, 'did-start-loading');
    return loading;
  }

  /** A popup's webContents (window.open from a tab) as a tab of its own: Chromium keeps its opener. */
  adopt(webContents) {
    return this.#track(new this.o.WebContentsView({ webContents }));
  }

  #track(view) {
    const wc = view.webContents;
    VIEW_TABS.add(allowPinch(wc));
    const entry = {
      id: wc.id,
      view,
      wc,
      /** the app window showing it, or null (parked) */
      win: null,
      bounds: { x: 0, y: 0, width: PARKED.width, height: PARKED.height },
      /** pane webContents that bound it */
      binders: new Set(),
      /** pane ids it was bound under */
      panes: new Set(),
      /** an agent's tab: it outlives the windows that showed it */
      keep: false,
      /** @type {string | null} the chat whose pane bound it last, or null (a pane of no chat) */
      chat: null,
    };
    this.entries.set(entry.id, entry);
    // before the pane hears of the navigation, so its state has the zoom the new page takes. Only a shown view: a
    // parked one's width would set the zoom its host shares with the page a pane shows (show refits it later)
    wc.on('did-navigate', () => entry.win && this.#refit(entry, false));
    for (const type of PAGE_EVENTS) wc.on(type, () => this.#emit(entry, type));
    // A shown page may remain the native first responder after the app selects another tool.
    // Reannounce deliberate input; background automation on parked or unfocused pages cannot select a tool.
    const inputFocus = (_event, input) => {
      if (entry.win && (input.type === 'mouseDown' || input.type === 'keyDown') && wc.isFocused()) this.#emit(entry, 'focus');
    };
    wc.on('before-mouse-event', inputFocus);
    wc.on('before-input-event', inputFocus);
    // a navigation that became a download reaches the pane as no failure (its notice and Retry would load it again: #1484)
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && wasDownload(wc, validatedURL)) return;
      this.#emit(entry, 'did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
    });
    // the pane's find bar (browserPanel/FindBar.tsx) reads the result as a <webview>'s event.result
    wc.on('found-in-page', (_e, result) => this.#emit(entry, 'found-in-page', { result }));
    wc.on('console-message', (e) => {
      const message = String(e?.message ?? '');
      if (message.startsWith(ANNOTATE_SIGNAL)) this.#emit(entry, 'console-message', { message });
    });
    wc.once('destroyed', () => this.#gone(entry));
    this.#park(entry);
    this.o.onCreated?.(wc);
    return entry;
  }

  /** The entry of a view's webContents (or its id), or null. */
  entryOf(wcOrId) {
    const id = typeof wcOrId === 'number' ? wcOrId : wcOrId?.id;
    const entry = this.entries.get(id);
    return entry && (typeof wcOrId === 'number' || entry.wc === wcOrId) ? entry : null;
  }

  /** The page's state as the pane shows it. */
  state(entry) {
    const wc = entry.wc;
    const history = wc.navigationHistory;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: !!history?.canGoBack(),
      canGoForward: !!history?.canGoForward(),
      loading: !!entry.previewLoad || wc.isLoading(),
      zoom: wc.getZoomFactor(),
      zoomAuto: this.zoom.isAuto(wc),
    };
  }

  /** @param {Record<string, unknown> | null} [detail] */
  #emit(entry, type, detail = null) {
    const payload = { id: entry.id, type, state: entry.wc.isDestroyed() ? null : this.state(entry), detail };
    for (const b of entry.binders) {
      if (b.isDestroyed() || (type === 'focus' && (!entry.win || this.o.windowOf(b) !== entry.win))) continue;
      b.send('browser:viewEvent', payload);
    }
  }

  /** Names `entry` by a pane id: a pane tab with that id binds to it. */
  name(entry, paneId) {
    this.panes.set(paneId, entry);
    entry.panes.add(paneId);
  }

  /**
   * A window's pane tab asks for its page (IPC browser:viewBind): the view its pane id names, else the
   * agent tab its chat and key name, else a new view for `url` in `partition`. Returns { id, state },
   * { closed: true } for a tab whose page went, or null for a bad request. `chat` is the chat whose
   * pane binds it (a user's tab), `chatId` the agent's chat whose tab it is.
   * @param {{ chatId?: string | null, chat?: string | null, tabKey?: string | null, url?: string, partition?: string }} req
   */
  bind(paneId, sender, req = {}) {
    if (typeof paneId !== 'string' || !paneId || !this.o.windowOf(sender)) return null;
    if (this.closed.has(paneId)) return { closed: true };
    const chatId = typeof req.chatId === 'string' && req.chatId ? req.chatId : null;
    const chat = chatId ?? (typeof req.chat === 'string' && req.chat ? req.chat : null);
    let entry = this.panes.get(paneId) ?? null;
    if (!entry && chatId) entry = this.entryOf(this.o.agentView?.(chatId, typeof req.tabKey === 'string' ? req.tabKey : null));
    if (!entry) {
      const url = typeof req.url === 'string' ? req.url : '';
      if (url !== 'about:blank' && !isWebUrl(url)) return null;
      entry = this.create({ partition: req.partition, url, chat });
    }
    if (chatId) entry.keep = true;
    if (chat) entry.chat = chat;
    this.name(entry, paneId);
    entry.binders.add(sender);
    if (!this.senders.has(sender)) {
      this.senders.add(sender);
      sender.once('destroyed', () => this.#released(sender));
      // a reloaded window starts its panes over: what it bound is released as if it closed
      sender.on('did-navigate', () => this.#released(sender));
    }
    return { id: entry.id, state: this.state(entry) };
  }

  /** A pane's window went (or reloaded): its user views no other window bound go with it; agents' views stay. */
  #released(sender) {
    for (const entry of [...this.entries.values()]) {
      if (!entry.binders.delete(sender)) continue;
      if (!entry.keep && !entry.binders.size) this.close(entry);
    }
  }

  /**
   * Where a window's pane shows a view (IPC browser:viewBounds): `rect` in the pane's CSS pixels, or
   * null to hide it. Only the window showing a view hides it. False for an unknown view or window.
   */
  show(id, sender, rect) {
    const entry = this.entryOf(id);
    const win = this.o.windowOf(sender);
    if (!entry || !win || win.isDestroyed()) return false;
    const bounds = rect ? scaleBounds(rect, sender.getZoomFactor()) : null;
    if (!bounds) {
      if (entry.win === win) this.#park(entry);
      return true;
    }
    if (entry.win !== win) {
      win.contentView.addChildView(entry.view);
      entry.win = win;
      if (!this.watched.has(win)) {
        this.watched.add(win);
        win.once('closed', () => this.#windowClosed(win));
      }
    }
    entry.bounds = bounds;
    entry.view.setBounds(bounds);
    this.#refit(entry);
    return true;
  }

  /** Puts a view's page at its zoom for the view's width; the pane hears of a change when `tell`. */
  #refit(entry, tell = true) {
    if (this.zoom.apply(entry.wc, entry.bounds.width) && tell) this.#emit(entry, 'zoom-changed');
  }

  /** A page's explicit viewport came or went (pageZoom.cjs holdNativeScale). */
  #refitPage(wc) {
    const entry = this.entryOf(wc);
    if (entry) this.#refit(entry);
  }

  /** The pane's Zoom In, Zoom Out or Actual Size on a view: every view of that site takes it (Chromium shares it). */
  #zoomSite(entry, action) {
    if (!this.zoom.step(entry.wc, entry.bounds.width, action)) return;
    const host = hostOf(entry.wc);
    for (const e of this.entries.values()) if (e !== entry && !e.wc.isDestroyed() && hostOf(e.wc) === host) this.#refit(e);
    // told even when the zoom stayed (a step to what the fit gave): the pane shows whether the site follows the fit
    this.zoom.apply(entry.wc, entry.bounds.width);
    this.#emit(entry, 'zoom-changed');
  }

  /** The chat whose pane shows a view's page, or null (not a view, or a pane of no chat). */
  chatOf(wc) {
    return this.entryOf(wc)?.chat ?? null;
  }

  /** The app window showing a view's page, or null (parked). */
  windowOf(wc) {
    const win = this.entryOf(wc)?.win;
    return win && !win.isDestroyed() ? win : null;
  }

  #windowClosed(win) {
    for (const entry of this.entries.values()) if (entry.win === win) this.#park(entry);
  }

  #parking() {
    if (!this.park || this.park.isDestroyed())
      this.park = new this.o.BrowserWindow({
        show: false,
        width: PARKED.width,
        height: PARKED.height,
        skipTaskbar: true,
        focusable: false,
        paintWhenInitiallyHidden: true,
        title: 'Built-in browser',
        webPreferences: { ...HARDENED },
      });
    return this.park;
  }

  #park(entry) {
    const park = this.#parking();
    entry.win = null;
    park.contentView.addChildView(entry.view);
    entry.view.setBounds({ x: 0, y: 0, width: entry.bounds.width, height: entry.bounds.height });
    // the parking window covers every parked page, so none is clipped
    let width = Number(PARKED.width);
    let height = Number(PARKED.height);
    for (const e of this.entries.values())
      if (!e.win) {
        width = Math.max(width, e.bounds.width);
        height = Math.max(height, e.bounds.height);
      }
    park.setContentSize(width, height);
  }

  /** Lets the parking window go (every app window closed where that quits the app); parked views stay alive. */
  dropPark() {
    const park = this.park;
    this.park = null;
    if (park && !park.isDestroyed()) {
      for (const entry of this.entries.values()) if (!entry.win) park.contentView.removeChildView(entry.view);
      park.destroy();
    }
  }

  /** Release browser pages before app windows close, so their close handlers cannot recreate the parking window. */
  shutdown() {
    for (const entry of [...this.entries.values()]) this.close(entry);
    this.entries.clear();
    this.panes.clear();
    this.zoom.dispose();
    this.dropPark();
  }

  /** Closes a view (an entry, its webContents or its pane id); its page goes as when it calls window.close(). */
  close(target) {
    const entry = typeof target === 'string' ? this.panes.get(target) : target?.view ? target : this.entryOf(target);
    if (!entry || entry.wc.isDestroyed()) return false;
    entry.wc.close();
    return true;
  }

  #gone(entry) {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    for (const paneId of entry.panes) {
      if (this.panes.get(paneId) === entry) this.panes.delete(paneId);
      this.closed.add(paneId);
      if (this.closed.size > CLOSED_MAX) this.closed.delete(this.closed.values().next().value);
    }
    const parent = entry.win ?? this.park;
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(entry.view);
    entry.win = null;
    this.#emit(entry, 'closed');
    if (!this.entries.size) this.dropPark();
  }

  /**
   * The pane's toolbar (IPC browser:viewNav): back, forward, reload, stop, zoom-in, zoom-out, zoom-reset, load
   * `url` (web addresses and about:blank only), find (`url` is { text, forward, findNext }: the request id) or stop-find. Throws for
   * a view that went.
   */
  nav(id, sender, action, url) {
    const entry = this.entryOf(id);
    if (!entry || !this.o.windowOf(sender)) throw new Error('This browser page is no longer available.');
    const wc = entry.wc;
    if (['back', 'forward', 'load', 'reload', 'reloadIgnoringCache'].includes(action)) wc.emit(STOP_LOADING);
    if (['back', 'forward', 'stop'].includes(action)) cancelPaneLoad(entry);
    if (['back', 'forward'].includes(action)) entry.previewUrl = null;
    switch (action) {
      case 'back':
        return void wc.navigationHistory.goBack();
      case 'forward':
        return void wc.navigationHistory.goForward();
      case 'reloadIgnoringCache':
        return this.#load(entry, entry.previewUrl ?? wc.getURL(), (resolved) =>
          resolved === wc.getURL() ? wc.reloadIgnoringCache() : wc.loadURL(resolved),
        );
      case 'reload':
        return this.#load(entry, entry.previewUrl ?? wc.getURL(), (resolved) =>
          resolved === wc.getURL() ? wc.reload() : wc.loadURL(resolved),
        );
      case 'stop':
        stopLoading(wc);
        return this.#emit(entry, 'did-stop-loading');
      case 'zoom-in':
      case 'zoom-out':
      case 'zoom-reset':
        return void this.#zoomSite(entry, action.slice(5));
      case 'find': {
        const text = typeof url?.text === 'string' ? url.text : '';
        if (!text || text.length > 1000) throw new Error('Nothing to find on this page.');
        return wc.findInPage(text, { forward: url.forward !== false, findNext: url.findNext === true });
      }
      case 'stop-find':
        return void wc.stopFindInPage('clearSelection');
      case 'load':
        // about:blank as bind takes it: the only address a tab that never had a web page can recover from a crash at
        if (url !== 'about:blank' && !isWebUrl(url)) throw new Error('This browser supports http and https pages.');
        // a URL that downloads ends the load with an error: the download is the answer, not a failure (#1484)
        return Promise.resolve(this.#load(entry, url)).then(
          () => undefined,
          (error) => {
            if (wasDownload(wc, url)) return undefined;
            throw error;
          },
        );
      default:
        throw new Error('Unknown browser action.');
    }
  }
}

/**
 * The pane's IPC for its tabs' views: browser:viewBind (paneId, req), browser:viewBounds (id, rect |
 * null), browser:viewNav (id, action, url?) and browser:viewClose (paneId). Push: browser:viewEvent.
 * @param {{ handle: (channel: string, fn: (...a: any[]) => any) => void }} ipcMain
 * @param {() => PaneViews | null | undefined} views
 */
function registerViewIpc(ipcMain, views) {
  ipcMain.handle(
    'browser:viewBind',
    (e, paneId, req) => views()?.bind(paneId, e.sender, req && typeof req === 'object' ? req : {}) ?? null,
  );
  ipcMain.handle('browser:viewBounds', (e, id, rect) => !!views()?.show(id, e.sender, rect ?? null));
  ipcMain.handle('browser:viewNav', (e, id, action, url) => {
    const v = views();
    if (!v) throw new Error('This browser page is no longer available.');
    return v.nav(id, e.sender, action, url);
  });
  ipcMain.handle('browser:viewClose', (_e, paneId) => typeof paneId === 'string' && !!views()?.close(paneId));
}

module.exports = {
  PaneViews,
  registerViewIpc,
  isViewTab,
  focusForInput,
  emulatesFocus,
  FOCUS_EMULATION,
  scaleBounds,
  HARDENED,
  PARKED,
  ANNOTATE_SIGNAL,
  CLOSED_MAX,
};

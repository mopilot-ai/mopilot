// The built-in browser's pages for the pane: native popups keep Chromium's opener, POST body and OAuth postMessage/close; each page's notices (load failures, untrusted certificates, blocked app links, hangs, its own dialogs) carry what their actions need; a page that asks to confirm leaving is answered.
// Only panel guests and their explicitly registered descendants may use this window policy.
// A pane tab main owns (views.cjs) opens its popups as tabs of the same pane instead (openTab, through
// the window open handler's createWindow, which keeps the opener as a native window does).
const { browserShortcuts } = require('./browserShortcuts.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { isWebUrl, isIdentityProvider, restartUrl } = require('../../../shared/browser.mjs');
const { isFailedLoad } = require('./downloadNavigations.cjs');
const { assertCdpTarget } = require('./cdp.cjs');
const { isViewTab } = require('./views.cjs');
const { watchPasskeys } = require('./passkeys.cjs');
const { MEMORY_MESSAGE } = require('./memoryGuard.cjs');
const { formPost } = require('./formPosts.cjs');
const { webMcpPrefs } = require('./webmcp.cjs');
const { applyHonestIdentity } = require('./honestIdentity.cjs');
// DISMISSABLE: the notices the user may put away, shared with the pane's close buttons (noticeCloseAction)
const {
  CRASHED_MESSAGE,
  DISMISSABLE,
  UNRESPONSIVE_MESSAGE,
  blockedAddress,
  blockedAddressNote,
  loadFailure,
} = require('../../../shared/browserNotice.mjs');
const LOAD_NOTICE_MS = 30_000;
/** How long stopping a hung page waits for its renderer to go. */
const STOP_MS = 3_000;
/** Notices a finished load leaves up: they are about the page, not its loading. */
const STICKY = ['failed', 'crashed', 'blocked', 'unresponsive'];

class BrowserWindows {
  /**
   * openTab: wraps a view tab's popup (createWindow's options.webContents) as a pane tab and returns its webContents
   * broadcast: a view tab's notices, to every window (a view has no host window; panes match its id)
   * dialogs: the pages' own dialogs (pageDialogs.cjs), shown on their notices; hang: which pages stopped responding (pageHang.cjs)
   * acting: whether an agent's action on the page is under way now (BrowserTabs.acting): leaving it is the agent's doing
   * askLeave: asks the user whether to leave a page that asked to confirm it (beforeunload), on the window showing
   *   it; null when no window shows it
   * note: tells the agent driving a page what happened on it, in its next result (BrowserTabs.notePage)
   * openExternal: hands an app link to the system, only on the user's click
   * systemLanguages: the OS's languages, most preferred first: what each page's session asks sites for (honestIdentity.cjs)
   */
  constructor({
    BrowserWindow,
    appContents,
    panelSession,
    onPopup = (_opener, _popup) => {
      /* no popup listener */
    },
    openTab = /** @type {((opener: any, options: any, url: string) => any) | null} */ (null),
    broadcast = /** @type {((channel: string, payload: any) => void) | null} */ (null),
    dialogs = /** @type {InstanceType<typeof import('./pageDialogs.cjs').PageDialogs> | null} */ (null),
    hang = /** @type {InstanceType<typeof import('./pageHang.cjs').PageHang> | null} */ (null),
    acting = /** @type {(wc: any) => boolean} */ ((_wc) => false),
    askLeave = /** @type {(wc: any) => boolean | null} */ ((_wc) => null),
    note = /** @type {(wc: any, text: (tabId: string) => string, cdp?: (text: string) => { method: string, params: any }) => void} */ (
      (_wc, _text, _cdp) => undefined
    ),
    shortcutBindings = () => ({}),
    openExternal = /** @type {(url: string) => Promise<unknown>} */ (
      async (_url) => {
        throw new Error('Opening links in other apps is not available here.');
      }
    ),
    systemLanguages = /** @type {() => string[]} */ (() => []),
  }) {
    this.BrowserWindow = BrowserWindow;
    this.appContents = appContents;
    this.panelSession = panelSession;
    this.onPopup = onPopup;
    this.openTab = openTab;
    this.broadcast = broadcast;
    this.dialogs = dialogs;
    this.hang = hang;
    this.acting = acting;
    this.askLeave = askLeave;
    this.note = note;
    this.openExternal = openExternal;
    this.shortcutBindings = shortcutBindings;
    this.systemLanguages = systemLanguages;
    this.pages = new Map();
    /** numbers each app link a page tried to open */
    this.linkSeq = 0;
    // a page's dialog opening or closing shows on its notice
    const dialogChanged = (wc) => {
      const page = this.pages.get(wc.id);
      if (page) this.refresh(page);
    };
    dialogs?.on('open', dialogChanged);
    dialogs?.on('closed', dialogChanged);
    hang?.on('change', (wc, hung) => {
      const page = this.pages.get(wc.id);
      if (!page) return;
      if (hung) this.event(page, 'unresponsive', UNRESPONSIVE_MESSAGE);
      else if (page.notice?.kind === 'unresponsive') this.event(page, 'ready');
    });
  }

  /** Main-owned views have no guest host; only present contents can identify a native window. */
  windowOf(wc) {
    return wc ? this.BrowserWindow.fromWebContents(wc) : null;
  }

  owned(id, host) {
    const page = this.pages.get(id);
    if (!page || page.wc.isDestroyed() || page.root.isDestroyed()) throw new Error('This browser page is no longer available.');
    assertCdpTarget(page.root, { appContents: this.appContents(), panelSession: this.panelSession(), host });
    return page;
  }

  /** `reason` narrows a failure or a block (shared/browserNotice.mjs): which actions the pane offers depends on it. */
  event(page, kind, message = '', reason = /** @type {string | null} */ (null), detail = /** @type {string | null} */ (null)) {
    const host = page.host;
    // no URL yet: the notice has no origin
    const origin = urlPart(page.wc, 'origin');
    const d = this.dialogs?.of(page.wc);
    page.notice = {
      rootId: page.rootId,
      pageId: page.pageId,
      kind,
      message,
      reason,
      // the raw error behind a failure's words, for the notice's tooltip
      detail,
      origin,
      ...page.passkeys.notice(),
      dialog: d ? { id: d.id, type: d.type, message: d.message, defaultPrompt: d.defaultPrompt, frame: d.frame } : null,
      // which app link the notice offers to open: "Open in app" opens that one, never one the page set since
      link: page.appLink?.id ?? null,
    };
    if (!host) this.broadcast?.('browser:event', page.notice);
    else if (!host.isDestroyed()) host.send('browser:event', page.notice);
  }

  register(wc, root = wc) {
    if (this.pages.has(wc.id)) return;
    assertCdpTarget(root, { appContents: this.appContents(), panelSession: this.panelSession() });
    applyHonestIdentity(wc, this.systemLanguages);
    const page = {
      wc,
      root,
      host: root.hostWebContents ?? null,
      rootId: root.id,
      pageId: wc.id,
      timer: /** @type {NodeJS.Timeout | undefined} */ (undefined),
      notice:
        /** @type {{ rootId: number, pageId: number, kind: string, message: string, reason: string | null, origin: string, passkey: boolean, passkeySystem?: boolean, systemPasskeys?: boolean, legacyPasskeys?: boolean, dialog: { id: number, type: string, message: string, defaultPrompt: string, frame: string } | null, link: number | null } | null} */ (
          null
        ),
      /** the app link the page tried to open last, which the user may open with "Open in app" */
      appLink: /** @type {{ url: string, id: number } | null} */ (null),
      taskUrl: /** @type {string | null} */ (null),
      /** the memory guard stopped its renderer, and its crash has not been reported yet */
      memoryStop: false,
      // set just below, before any event: its change callback needs the page
      passkeys: /** @type {ReturnType<typeof watchPasskeys>} */ (/** @type {any} */ (null)),
    };
    this.pages.set(wc.id, page);
    if (root !== wc) wc.setIgnoreMenuShortcuts(true);
    else {
      const deliver = (combo, modifiers = false) => {
        const payload = { rootId: root.id, combo, ...(modifiers ? { modifiers: true } : {}) };
        if (page.host) {
          if (!page.host.isDestroyed()) page.host.send('browser:shortcut', payload);
        } else this.broadcast?.('browser:shortcut', payload);
      };
      browserShortcuts(wc, this.shortcutBindings, deliver, process.platform, (combo) => deliver(combo, true));
    }
    // the pane learns when the page starts or stops waiting on a passkey, with its current notice
    page.passkeys = watchPasskeys(wc, () => this.refresh(page));
    this.hang?.watch(wc);
    const stopTimer = () => {
      clearTimeout(page.timer);
      page.timer = undefined;
    };
    const title = () => {
      if (root === wc) return;
      const win = this.windowOf(wc);
      if (!win || win.isDestroyed()) return;
      // no URL yet: the generic title
      const address = urlPart(wc, 'host') || 'New window';
      win.setTitle(`Built-in browser — ${address}`);
    };
    wc.on('page-title-updated', (event) => {
      if (root !== wc) event.preventDefault();
      title();
    });
    wc.on('did-start-loading', () => {
      stopTimer();
      // a page that stopped responding keeps its notice (and its Wait, Reload and Close tab) until it responds
      if (this.hang?.hung(wc)) return;
      this.event(page, 'loading');
      page.timer = setTimeout(
        () => this.event(page, 'slow', 'This page is taking longer than expected. You can stop loading, retry, or continue in Chrome.'),
        LOAD_NOTICE_MS,
      );
      page.timer.unref?.();
    });
    wc.on('did-stop-loading', () => {
      stopTimer();
      if (!(/** @type {(string | undefined)[]} */ (STICKY).includes(page.notice?.kind))) this.event(page, 'ready');
    });
    wc.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      // not a cancelled navigation (Stop included), nor one that became a download, whatever became of it (#1484)
      if (!isFailedLoad(wc, code, url, mainFrame)) return;
      stopTimer();
      const failure = loadFailure(code, description);
      this.event(page, 'failed', failure.message, failure.reason, failure.detail);
    });
    // A page asks to confirm leaving it (beforeunload). Electron answers "stay" unless this says otherwise, and it
    // must be answered now: an agent's own action leaves (and the agent is told), the user is asked on the window
    // showing the page, and a page no window shows leaves, as nobody could answer.
    wc.on('will-prevent-unload', (event) => {
      let leave = true;
      if (this.acting(wc))
        this.note(
          wc,
          (tabId) =>
            `beforeunload ${tabId}: the page asked to confirm leaving it (it may have unsaved changes); it was left, as your action asked`,
        );
      else leave = this.askLeave(wc) !== false;
      if (leave) event.preventDefault();
    });
    wc.on('render-process-gone', (_event, details) => {
      stopTimer();
      // the memory guard stopped it (memoryGuard.cjs), or the renderer itself ran out of memory
      const memory = page.memoryStop || details?.reason === 'oom';
      page.memoryStop = false;
      this.event(page, 'crashed', memory ? MEMORY_MESSAGE : CRASHED_MESSAGE);
    });
    wc.on('did-navigate', () => {
      // a new document: the old one's app link is not on offer any more
      page.appLink = null;
      title();
      this.event(page, 'navigated');
    });
    wc.on('did-start-navigation', (event, url, _inPlace, mainFrame) => {
      const destination = event.url || url;
      if ((event.isMainFrame ?? mainFrame) && isWebUrl(destination) && !isIdentityProvider(destination)) page.taskUrl = destination;
    });
    // Block local/app protocols, including redirects. about:blank is needed for window.open('', ...).
    const navigation = (event, url) => {
      const destination = event.url || url;
      if (destination !== 'about:blank' && !isWebUrl(destination)) {
        event.preventDefault();
        this.blocked(page, destination);
      }
    };
    wc.on('will-navigate', navigation);
    wc.on('will-redirect', navigation);
    wc.setWindowOpenHandler(({ url }) => {
      if (url !== 'about:blank' && !isWebUrl(url)) {
        this.blocked(page, url);
        return { action: 'deny' };
      }
      // a view tab's popup is a tab of the same pane: Chromium still gives it the opener, POST body and window.close.
      // As a tab it outlives its opener, as in Chrome: Electron destroys a popup with its opener otherwise (#1777).
      if (this.openTab && isViewTab(root))
        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: (options) => /** @type {(opener: any, options: any, url: string) => any} */ (this.openTab)(wc, options, url),
        };
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: this.windowOf(root.hostWebContents),
          width: 560,
          height: 760,
          minWidth: 360,
          minHeight: 400,
          show: true,
          frame: true,
          title: 'Built-in browser',
          autoHideMenuBar: true,
          // the opener tab's session (the shared profile or its chat's own): an OAuth popup shares its sign-in
          webPreferences: {
            session: root.session,
            preload: undefined,
            nodeIntegration: false,
            // the page dialogs' preload runs in its frames too (sandboxed: no Node)
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
            // a popup's page publishes tools (WebMCP) as its opener's does
            ...webMcpPrefs(),
          },
        },
      };
    });
    wc.on('did-create-window', (win) => {
      this.register(win.webContents, root);
      win.setMenu(null);
      this.onPopup(wc, win.webContents);
      this.event(this.pages.get(win.webContents.id), 'opened');
      win.focus();
    });
    wc.once('destroyed', () => {
      stopTimer();
      this.event(page, 'closed');
      this.pages.delete(page.pageId);
      if (root === wc) {
        for (const child of [...this.pages.values()]) {
          if (child.root === root && !child.wc.isDestroyed()) this.windowOf(child.wc)?.close();
        }
      } else if (!root.isDestroyed() && (!page.host || !page.host.isDestroyed())) {
        const remaining = [...this.pages.values()].filter((p) => p.root === root && !p.wc.isDestroyed()).at(-1);
        if (remaining) this.focus(remaining.pageId, page.host);
      }
    });
  }

  /** Shows the page's notice again as it is, with its dialog and passkey state now. */
  refresh(page) {
    this.event(page, page.notice?.kind ?? 'ready', page.notice?.message ?? '', page.notice?.reason ?? null);
  }

  /** A page tried to open a non-web address: an app link the user may open with a click, or one never opened. The agent driving the page is told too. */
  blocked(page, url) {
    const b = blockedAddress(url);
    page.appLink = b.reason === 'app-link' ? { url, id: ++this.linkSeq } : null;
    this.event(page, 'blocked', b.message, b.reason);
    // a CDP client (the Codex plugin) hears it as a blocked navigation, as it does the backend's own URL policy
    this.note(
      page.wc,
      (tabId) => blockedAddressNote(tabId, url),
      (text) => ({ method: 'Page.navigationBlocked', params: { errorText: text, url } }),
    );
  }

  /** A frame of a registered page asked the system to open `url` (the openExternal permission Electron asks instead of navigating a frame). */
  external(wc, url) {
    const page = wc && this.pages.get(wc.id);
    if (page && url) this.blocked(page, String(url));
  }

  /**
   * "Open in app": the app link the notice the user clicked offered (`linkId`), handed to the system now that they
   * asked for it. A link the page (or a frame) set after the notice showed is never opened in its place.
   */
  async openAppLink(id, linkId, host) {
    const page = this.owned(id, host);
    const link = page.appLink;
    if (!link || link.id !== linkId) throw new Error('This page has another app link now, or none: look at its notice again.');
    page.appLink = null;
    this.event(page, 'ready');
    await this.openExternal(link.url);
    return true;
  }

  /** "Dismiss": puts away a notice about a blocked link or a failed load. False for a notice that can't be put away. */
  dismiss(id, host) {
    const page = this.owned(id, host);
    if (!DISMISSABLE.includes(page.notice?.kind ?? '')) return false;
    page.appLink = null;
    this.event(page, 'ready');
    return true;
  }

  /**
   * Stops a page's renderer (it stopped responding: Reload and Close tab start here). Its contents stay and load
   * again in a new renderer; false when the renderer is gone already.
   */
  async stop(id, host) {
    const { wc } = this.owned(id, host);
    if (wc.isCrashed()) return false;
    // resolves once the renderer is gone (the page can load again then), or after STOP_MS whatever happened
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.removeListener('render-process-gone', done);
        resolve(null);
      };
      const timer = setTimeout(done, STOP_MS);
      timer.unref?.();
      wc.once('render-process-gone', done);
      wc.forcefullyCrashRenderer();
    });
    return true;
  }

  /** Loads a stopped page again in its new renderer (a hung popup window's Reload, after stop). */
  reload(id, host) {
    this.owned(id, host).wc.reload();
    return true;
  }

  /**
   * The notice's Resubmit: posts the page's form again, with the data it sent (formPosts.cjs), as Chrome does once the
   * user confirms. A reload can't: Electron cancels one that would resubmit, and the page lost its form data.
   */
  async resubmit(id, host) {
    const { wc } = this.owned(id, host);
    const url = wc.getURL();
    const post = formPost(wc.id, url);
    if (!post) throw new Error('its form data is gone. Fill in the form again');
    await wc.loadURL(url, { postData: post.postData, extraHeaders: `Content-Type: ${post.contentType}` });
    return true;
  }

  /** Mutes or unmutes a pane page's audio (the tab menu's Mute tab); answers whether the page is muted now. */
  setAudioMuted(id, muted, host) {
    const { wc } = this.owned(id, host);
    wc.setAudioMuted(muted);
    return wc.isAudioMuted();
  }

  /** The user answers the page's dialog in the pane; false when it was answered already (by the agent) or went. */
  answerDialog(id, dialogId, accept, text, host) {
    const { wc } = this.owned(id, host);
    return !!this.dialogs?.answer(wc, typeof dialogId === 'number' ? dialogId : null, !!accept, text ?? null, 'user');
  }

  /**
   * The memory guard stopped `wc`'s renderer (memoryGuard.cjs). Its report and the crash reach main in
   * either order: a crash already shown gets the memory reason now, else the coming one does.
   */
  stoppedForMemory(wc) {
    const page = this.pages.get(wc?.id);
    if (!page || page.wc !== wc) return;
    if (page.notice?.kind === 'crashed') this.event(page, 'crashed', MEMORY_MESSAGE);
    else page.memoryStop = true;
  }

  state(id, host) {
    const { root } = this.owned(id, host);
    return [...this.pages.values()]
      .filter((p) => p.root === root)
      .map(
        (p) =>
          p.notice || {
            rootId: root.id,
            pageId: p.wc.id,
            kind: 'ready',
            message: '',
            reason: null,
            origin: '',
            passkey: false,
            dialog: null,
            link: null,
          },
      );
  }

  restart(id, host) {
    const { root } = this.owned(id, host);
    const history = root.navigationHistory?.getAllEntries?.() || [];
    return restartUrl([this.pages.get(root.id)?.taskUrl, root.getURL(), ...history.map((e) => e.url).reverse()]);
  }

  focus(id, host) {
    const { wc, root } = this.owned(id, host);
    const win = this.windowOf(wc === root ? root.hostWebContents : wc);
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
    wc.focus();
  }

  /** Ends the passkey requests a page is waiting on, so the site offers its other sign-in methods (`legacy`: see passkeys.cjs). */
  cancelPasskey(id, host, legacy = false) {
    return this.owned(id, host).passkeys.cancel({ legacy: legacy === true });
  }

  closePopup(id, host) {
    const { wc, root } = this.owned(id, host);
    if (wc === root) throw new Error('Close this tab from the tab bar.');
    this.windowOf(wc)?.close();
  }
}

/**
 * A part of a page's URL ('origin', 'host'); '' while it has no URL that parses (a new window) or once it has gone.
 * @param {{ getURL(): string }} wc
 * @param {'origin' | 'host'} part
 */
function urlPart(wc, part) {
  let url = '';
  try {
    url = wc.getURL();
  } catch (error) {
    noteIgnored('read the URL of a browser window', error);
  }
  return URL.canParse(url) ? new URL(url)[part] : '';
}

module.exports = { BrowserWindows };

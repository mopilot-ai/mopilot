// A tab in the user's Chrome, reached over the Chrome relay (chromeRelay.cjs), shaped like the webContents a browser host tab (tab.cjs) drives.
//
// The browser host's tabs (host.cjs, tab.cjs and the layers on them) are CDP-based: they use a page's
// webContents for its debugger, a few events and some state. ChromeTabContents gives them those over
// the relay, so the browser_* tool implementations drive a Chrome tab unchanged. What differs from a
// pane tab:
// - debugger.attach is answered at once and runs over the relay; every command waits for it and carries
//   the turn token taken when it attached (a command after the turn ended is refused by the relay).
// - URL, title and loading come from the tab's CDP events (Page.frameNavigated, frameStartedLoading,
//   frameStoppedLoading, navigatedWithinDocument) and Target.getTargetInfo; the events the host waits on
//   (did-start-loading, did-stop-loading, did-navigate, did-navigate-in-page, destroyed) are emitted from them.
// - navigationHistory is a copy of Page.getNavigationHistory, read again after each navigation: back
//   and forward go to its entries with Page.navigateToHistoryEntry.
// - capturePage has nothing to capture in MoPilot: every screenshot goes through CDP
//   Page.captureScreenshot (hostCapture.cjs falls back to it).
// - There is no background throttling switch and no pane layer: the tab lives in Chrome's window, and the
//   extension's tab group, its badge and the agent cursor's control frame on the page show the user which tabs are driven.
// assertCdpTarget (cdp.cjs) lets only these objects through for a Chrome tab: isBackendTab (backend.cjs), then assertDrivable.
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { assertBrowserDispatch } = require('./credentialDocument.cjs');
const { markBackendTab } = require('./backend.cjs');
const { observeTabNavigation } = require('./tabNavigation.cjs');

/** The ids these contents get, apart from Electron's webContents ids. */
const ID_BASE = 2_000_000_000;
let nextId = 0;

/** Why a step on a tab the chat no longer holds is refused: the user's own act only when the extension reported one (#2325). */
const LOST = Object.freeze(
  Object.assign(Object.create(null), {
    removed_from_group: "The user dragged it out of the chat's tab group.",
    canceled_by_user: "The user cancelled Chrome's debugging bar on it.",
    closed: 'It was closed.',
  }),
);
const notOwned = (/** @type {string | undefined} */ why) =>
  `This Chrome tab is no longer one of this chat's tabs. ${(why && LOST[why]) || ''} Don't act on it again; list this chat's tabs or open another one.`.replace(
    /\s+/g,
    ' ',
  );

/** Whether `wc` is a Chrome tab over the relay (a ChromeTabContents). */
function isRelayTab(wc) {
  return wc instanceof ChromeTabContents;
}

/** The debugger of a Chrome tab: Electron's webContents.debugger API over the relay. */
class RelayDebugger extends EventEmitter {
  /** @param {ChromeTabContents} contents */
  constructor(contents) {
    super();
    this.contents = contents;
    this.attached = false;
    /** @type {Promise<void> | null} the relay attach in flight or done */
    this.ready = null;
    /** @type {{ chatId: string, turn: number, membership: string | null, link?: unknown } | null} the turn token this attach runs under */
    this.tok = null;
    /** @type {unknown} why the last attach failed: the next command says so instead of only "not attached" */
    this.failure = null;
    /** @type {Promise<unknown>} a retired attach's release must precede the next native acquisition */
    this.releasing = Promise.resolve();
  }

  isAttached() {
    return this.attached;
  }

  /**
   * Attaches over the relay: answered at once, as Electron's is; commands wait for it. An attach that
   * fails lets go again (the commands waiting on it get its error), so the next action attaches anew.
   */
  attach() {
    const c = this.contents;
    if (this.attached) return;
    this.attached = true;
    this.failure = null;
    this.tok = { ...c.relay.token(c.chatId), membership: c.membership };
    const tok = this.tok;
    const releasing = this.releasing;
    let dispatched = false;
    let acquired = false;
    const ready = c.created.then(async () => {
      tok.membership = c.membership;
      await releasing;
      this.#current(ready);
      // a tab kept from a connection that dropped reconnects first
      await c.resume();
      this.#current(ready);
      tok.link = c.relay.link(c.chatId);
      dispatched = true;
      await c.relay.attach(tok, c.tabId);
      acquired = true;
      this.#current(ready);
      await c.refresh(tok);
      this.#current(ready);
    });
    this.ready = ready;
    ready.catch((error) => {
      noteIgnored('attach to a Chrome tab over the relay', error);
      if (this.ready === ready) {
        // A timed-out command may still acquire natively; a known attach rejection owns no new effect.
        if (acquired || (dispatched && error?.code === 'timeout')) this.#release(tok, ready);
        this.lost('attach_failed', error);
      }
    });
  }

  /**
   * Lets go of the tab: never refused, whatever the turn. An attach still on its way is let go after it
   * lands, or Chrome would keep a debugger nobody owns.
   */
  detach() {
    if (!this.attached) return;
    const tok = /** @type {{ chatId: string, turn: number, membership: string | null, link?: unknown }} */ (this.tok);
    const prev = /** @type {Promise<void>} */ (this.ready);
    this.attached = false;
    this.ready = null;
    this.tok = null;
    this.#release(tok, prev);
  }

  /** Explicit retirement and a failed acquisition share one release barrier. */
  #release(tok, prev) {
    const c = this.contents;
    const release = () => {
      if (c.tabId != null && tok.link !== undefined)
        return c.relay.detach(tok, c.tabId).catch((error) => noteIgnored('detach from a Chrome tab over the relay', error));
    };
    this.releasing = prev.then(release, release);
  }

  /** A CDP command on the tab (or a child session), under the attach's turn token. */
  sendCommand(method, params = {}, sessionId = '') {
    return this.sendGuardedCommand(method, params, sessionId);
  }

  /** The Tab's optional receipt belongs to the actual relay dispatch, after attachment. */
  async sendGuardedCommand(method, params = {}, sessionId = '', onDispatch = /** @type {(() => void) | null} */ (null)) {
    if (!this.attached || !this.ready) throw this.failure ?? new ToolError('The Chrome tab is not attached.', 'failed');
    const tok = this.tok;
    const ready = this.ready;
    await ready;
    this.#current(ready);
    const c = this.contents;
    assertBrowserDispatch(c);
    const sent = c.relay.cdp(tok, { tabId: c.tabId, sessionId: sessionId || '' }, method, params);
    onDispatch?.();
    return sent;
  }

  /** Only this attach attempt may continue after creation, reconnect, relay setup or a queued command. */
  #current(ready) {
    if (this.ready !== ready) throw new ToolError('This Chrome debugger attachment was retired.', 'stale_turn');
  }

  /**
   * The relay lost the debugger (the user closed the infobar, the tab crashed), or the attach failed (`failure`: why,
   * which the next command reports until an attach starts again).
   * @param {string} reason @param {unknown} [failure]
   */
  lost(reason, failure = null) {
    this.failure = failure;
    if (!this.attached) return;
    this.attached = false;
    this.ready = null;
    this.tok = null;
    this.emit('detach', {}, reason);
  }
}

/**
 * One tab of a chat in the user's Chrome, as the browser host sees a webContents. `created` resolves
 * with the Chrome tab id once the tab exists (a new tab may still be opening when the host adds it).
 */
class ChromeTabContents extends EventEmitter {
  /**
   * @param {{ relay: InstanceType<typeof import('./chromeRelay.cjs').ChromeRelay>, chatId: string,
   *           tab?: { id: number, url?: string, title?: string, membership?: string } | null, open?: Promise<{ id: number, url?: string, title?: string, membership?: string }> | null }} o
   *   tab: a tab the chat's connection already reported; open: a tab still being opened
   */
  constructor({ relay, chatId, tab = null, open = null }) {
    super();
    this.id = ID_BASE + ++nextId;
    this.relay = relay;
    this.chatId = chatId;
    /** @type {number | null} */
    this.tabId = tab ? tab.id : null;
    this.membership = tab?.membership ?? null;
    this.url = tab?.url || '';
    this.title = tab?.title || '';
    this.loading = false;
    /** @type {string | null} why the page's document failed to load, for the error page that follows */
    this.pageError = null;
    /** @type {string | null} the request of the page's own document */
    this.pageRequest = null;
    this.destroyed = false;
    /** kept from a chat connection that dropped (suspend), until the next one reports it again or not (resumed) */
    this.resuming = false;
    this.userAgent = '';
    /** the top frame's id, from the first top-level frame event or the target info */
    this.mainFrame = null;
    /** Page.getNavigationHistory's answer, read after each navigation */
    this.history = { currentIndex: 0, entries: /** @type {{ id: number, url: string }[]} */ ([]) };
    this.debugger = new RelayDebugger(this);
    markBackendTab(this);
    this.created = tab
      ? Promise.resolve()
      : Promise.resolve(open)
          .then((t) => {
            if (!t || !Number.isInteger(t.id)) throw new ToolError("Chrome didn't open a tab.", 'failed');
            if (!this.relay.owns(this.chatId, t.id, t.membership))
              throw new ToolError('This Chrome tab membership was retired while it opened.', 'bad_target');
            this.tabId = t.id;
            this.membership = t.membership ?? null;
            this.url = t.url || this.url;
            this.title = t.title || this.title;
          })
          .catch((error) => {
            // the tab never opened: the host drops it; the error goes to the call that waits on it
            this.gone();
            throw error;
          });
    this.created.catch((error) => noteIgnored('open a Chrome tab over the relay', error));
    const navigationHistory = {
      getActiveIndex: () => this.history.currentIndex,
      length: () => this.history.entries.length,
      getEntryAtIndex: (i) => this.history.entries[i] ?? null,
      goBack: () => this.#go(-1),
      goForward: () => this.#go(1),
    };
    this.navigationHistory = navigationHistory;
  }

  /** Tokens for deferred commands retain this contents’ membership, never a later tab with the same id. */
  token() {
    return { ...this.relay.token(this.chatId), membership: this.membership };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  isLoading() {
    return this.loading;
  }

  getUserAgent() {
    return this.userAgent;
  }

  /** Nothing to capture in MoPilot: the host takes screenshots through CDP. */
  capturePage() {
    return Promise.resolve(null);
  }

  /** Chrome decides how a background tab is throttled. */
  setBackgroundThrottling() {
    /* not ours to change in the user's Chrome */
  }

  reload() {
    this.#send('Page.reload', {}, 'reload a Chrome tab');
  }

  /** browser_navigate "stop" (hostNavigation.cjs): Chrome ends the load and keeps what the page rendered. */
  stop() {
    this.#send('Page.stopLoading', {}, 'stop a Chrome tab loading');
  }

  /** For assertCdpTarget: the tab still exists in the chat's connection (a tab still opening waits for it). */
  assertDrivable() {
    if (this.destroyed)
      throw new ToolError(this.lostReason ? notOwned(this.lostReason) : 'Refusing to drive this page over CDP: it is gone', 'bad_target');
    if (this.tabId == null) return;
    const link = this.relay.link(this.chatId);
    // a tab kept from a connection that dropped: attaching reconnects first (resume)
    if (!link && this.resuming) return;
    if (!link) throw new ToolError('Your Chrome disconnected from this chat. Call the tool again to reconnect.', 'not_connected');
    if (!this.relay.owns(this.chatId, this.tabId, this.membership)) throw new ToolError(notOwned(link.lost?.get(this.tabId)), 'bad_target');
  }

  /** Reads the target info (URL, title, top frame), the history and the user agent again. */
  async refresh(tok = this.debugger.tok) {
    if (!tok || this.tabId == null) return;
    const target = { tabId: this.tabId };
    // each read is optional: what one cannot give keeps its last value
    const read = (method, params = {}) =>
      this.relay.cdp(tok, target, method, params).catch((error) => noteIgnored(`read ${method} of a Chrome tab`, error));
    const [info, hist, ua] = await Promise.all([
      read('Target.getTargetInfo'),
      read('Page.getNavigationHistory'),
      this.userAgent ? null : read('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }),
    ]);
    const t = info?.targetInfo;
    if (t) {
      this.mainFrame ??= t.targetId || null;
      if (typeof t.url === 'string') this.url = t.url;
      if (typeof t.title === 'string') this.title = t.title;
    }
    if (hist && Array.isArray(hist.entries)) this.history = { currentIndex: hist.currentIndex ?? 0, entries: hist.entries };
    const agent = ua?.result?.value;
    if (typeof agent === 'string') this.userAgent = agent;
  }

  #refreshLater() {
    if (!this.debugger.attached) return;
    this.refresh().catch((error) => noteIgnored('read a Chrome tab after a navigation', error));
  }

  #go(step) {
    const entry = this.history.entries[this.history.currentIndex + step];
    if (entry) this.#send('Page.navigateToHistoryEntry', { entryId: entry.id }, 'move in the history of a Chrome tab');
  }

  #send(method, params, what) {
    this.debugger.sendCommand(method, params).catch((error) => noteIgnored(what, error));
  }

  /** A CDP event of this tab, from the relay: the debugger's message, and the state and events the host reads. */
  event(source, method, params) {
    const sessionId = typeof source?.sessionId === 'string' ? source.sessionId : '';
    if (!sessionId && observeTabNavigation(this, method, params || {})) this.#refreshLater();
    this.debugger.emit('message', {}, method, params || {}, sessionId);
  }

  /**
   * The chat's connection dropped but the extension keeps the tab for the chat (chromeHost.cjs): its debugger is let
   * go (the tab's CDP setup runs again on the next attach) and the tab stays the host's, to reconnect on its next action.
   */
  suspend() {
    // a destroyed tab has left the host's map already: only live tabs get here
    this.resuming = true;
    // no load event reaches it while it has no debugger: the next attach reads the page again (refresh)
    this.loading = false;
    this.debugger.lost('disconnected');
  }

  /** The chat's next connection opened: the tab is the chat's again when it reported it, else it is gone. */
  resumed(reported) {
    this.resuming = false;
    if (!reported || (reported.membership ?? null) !== this.membership) this.gone();
  }

  /** Before attaching a tab kept from a connection that dropped: the chat's connection opens again, and must still have it. */
  async resume() {
    if (!this.resuming) return;
    await this.relay.connect(this.chatId);
    if (this.destroyed)
      throw new ToolError(
        "This Chrome tab is no longer open in the chat's tab group (it was closed or taken back while Chrome was away). Don't act on it again; open another tab.",
        'tab_closed',
      );
  }

  /** The tab closed, or the chat's connection went: the host lets go of it. */
  /** @param {string} [reason] what took the tab from the chat ('closed', or the user's detach reason), told to a step still naming it */
  gone(reason) {
    if (this.destroyed) return;
    if (reason) this.lostReason = reason;
    this.resuming = false;
    this.destroyed = true;
    this.debugger.lost('target_closed');
    this.emit('destroyed');
  }
}

module.exports = { ChromeTabContents, RelayDebugger, isRelayTab, ID_BASE };

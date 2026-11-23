// A tab of a headless Chromium on a remote Host, reached through the Host's browser service (host/src/browserHost.mjs), shaped like the webContents a browser host tab (tab.cjs) drives.
//
// Like ChromeTabContents (chromeTab.cjs) it gives the CDP-based tool layer a debugger, a few events and some state, so the
// browser_* tools drive it unchanged. What differs:
// - The service takes the tab as (hostId, chatId, targetId); every command goes through `transport`, which refuses a tab the chat does not own.
// - debugger.attach is answered at once and runs on the Host; commands wait for it. detach lets go of the tab's session on the Host
//   (the page stays), and the next attach takes it up again, as a turn end and the next turn do.
// - A command is refused here, before it leaves, when its call was stopped (actionGuard.cjs), the attach was retired (Stop) or the Host is unreachable.
// - Nothing to capture natively: screenshots go through CDP Page.captureScreenshot (hostCapture.cjs falls back to it).
// assertCdpTarget (cdp.cjs) lets only these objects through: isBackendTab (backend.cjs), then assertDrivable.
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { assertBrowserDispatch } = require('./credentialDocument.cjs');
const { markBackendTab } = require('./backend.cjs');
const { observeTabNavigation } = require('./tabNavigation.cjs');
const { checkAct } = require('../contract/actionGuard.cjs');

/** The ids these contents get, apart from Electron's webContents ids and the Chrome relay's. */
const ID_BASE = 1_900_000_000;
let nextId = 0;

/**
 * What a Host's browser service offers, as the tabs use it (host/src/browserHost.mjs is the service; electron/host has the wire).
 * @typedef {{ open: (chatId: string) => Promise<{ targetId: string, url?: string, title?: string }>,
 *   attach: (chatId: string, targetId: string) => Promise<unknown>, detach: (chatId: string, targetId: string) => Promise<unknown>,
 *   command: (chatId: string, req: { targetId: string, sessionId: string, method: string, params: object }) => Promise<any>,
 *   close: (chatId: string, targetId: string) => Promise<unknown>, alive: () => boolean }} RemoteTransport
 */

/** Whether `wc` is a tab on a remote Host. */
function isRemoteTab(wc) {
  return wc instanceof RemoteTabContents;
}

/** The debugger of a remote tab: Electron's webContents.debugger API over the Host. */
class RemoteDebugger extends EventEmitter {
  /** @param {RemoteTabContents} contents */
  constructor(contents) {
    super();
    this.contents = contents;
    this.attached = false;
    /** @type {Promise<void> | null} the attach in flight or done */
    this.ready = null;
    /** @type {unknown} why the last attach failed: the next command says so */
    this.failure = null;
  }

  isAttached() {
    return this.attached;
  }

  /** Attaches on the Host: answered at once, as Electron's is; commands wait for it. A failed attach lets go again. */
  attach() {
    const c = this.contents;
    if (this.attached) return;
    this.attached = true;
    this.failure = null;
    // a session let go (a turn end, Stop) is gone on the Host before this one is taken
    const releasing = c.settling;
    const ready = c.created.then(async () => {
      this.#current(ready);
      await releasing;
      this.#current(ready);
      await c.transport.attach(c.chatId, /** @type {string} */ (c.targetId));
      this.#current(ready);
      await c.refresh();
      this.#current(ready);
    });
    this.ready = ready;
    ready.catch((error) => {
      noteIgnored('attach to a remote tab', error);
      if (this.ready === ready) this.lost('attach_failed', error);
    });
  }

  /** Lets go of the tab's session on the Host: never refused. An attach still on its way is let go after it lands. */
  detach() {
    if (!this.attached) return;
    const prev = /** @type {Promise<void>} */ (this.ready);
    this.attached = false;
    this.ready = null;
    const c = this.contents;
    const release = () =>
      c.transport.detach(c.chatId, /** @type {string} */ (c.targetId)).catch((error) => noteIgnored('detach from a remote tab', error));
    prev.then(release, () => undefined);
  }

  /** A CDP command on the tab (or a frame's session). */
  sendCommand(method, params = {}, sessionId = '') {
    return this.sendGuardedCommand(method, params, sessionId);
  }

  /** The Tab's optional receipt belongs to the actual dispatch, after attachment. */
  async sendGuardedCommand(method, params = {}, sessionId = '', onDispatch = /** @type {(() => void) | null} */ (null)) {
    if (!this.attached || !this.ready) throw this.failure ?? new ToolError('The remote tab is not attached.', 'failed');
    const ready = this.ready;
    await ready;
    this.#current(ready);
    const c = this.contents;
    assertBrowserDispatch(c);
    // a call stopped since it began (Stop, a harness cancel) sends nothing more to the Host
    checkAct('a command in a browser on a Host');
    c.assertDrivable();
    const sent = c.transport.command(c.chatId, {
      targetId: /** @type {string} */ (c.targetId),
      sessionId: sessionId || '',
      method,
      params,
    });
    onDispatch?.();
    // a command answered, or failed by the Host letting go of the tab, after Stop or a detach is not the call's any more
    const out = await sent.catch((error) => {
      this.#current(ready);
      throw error;
    });
    this.#current(ready);
    return out;
  }

  /** Only this attach attempt may continue after creation, an attach or a queued command. */
  #current(ready) {
    if (this.ready !== ready) throw new ToolError('This remote debugger attachment was retired.', 'stale_turn');
  }

  /**
   * The Host lost the tab's session (the page crashed, Stop), or the attach failed (`failure`: why, which the next command reports).
   * @param {string} reason @param {unknown} [failure]
   */
  lost(reason, failure = null) {
    this.failure = failure;
    if (!this.attached) return;
    this.attached = false;
    this.ready = null;
    this.emit('detach', {}, reason);
  }
}

/**
 * One tab of a chat on a Host, as the browser host sees a webContents. `created` resolves with the Host's target id once the tab exists.
 */
class RemoteTabContents extends EventEmitter {
  /**
   * @param {{ transport: RemoteTransport, hostId: string, chatId: string,
   *           tab?: { targetId: string, url?: string, title?: string } | null,
   *           open?: Promise<{ targetId: string, url?: string, title?: string }> | null }} o
   *   tab: a tab the Host already has (a popup, or one the chat kept while the Mac was away); open: a tab still being opened
   */
  constructor({ transport, hostId, chatId, tab = null, open = null }) {
    super();
    this.id = ID_BASE + ++nextId;
    this.transport = transport;
    this.hostId = hostId;
    this.chatId = chatId;
    /** @type {string | null} */
    this.targetId = tab ? tab.targetId : null;
    this.url = tab?.url || '';
    this.title = tab?.title || '';
    this.loading = false;
    /** @type {string | null} why the page's document failed to load, for the error page that follows */
    this.pageError = null;
    /** @type {string | null} the request of the page's own document */
    this.pageRequest = null;
    this.destroyed = false;
    /** @type {string | undefined} what took the tab, told to a step still naming it */
    this.lostReason = undefined;
    this.userAgent = '';
    /** the top frame's id, from the first top-level frame event or the target info */
    this.mainFrame = null;
    /** Page.getNavigationHistory's answer, read after each navigation */
    this.history = { currentIndex: 0, entries: /** @type {{ id: number, url: string }[]} */ ([]) };
    /** @type {Promise<unknown>} what must finish on the Host before the tab is attached again */
    this.settling = Promise.resolve();
    this.debugger = new RemoteDebugger(this);
    markBackendTab(this);
    this.created = tab
      ? Promise.resolve()
      : Promise.resolve(open)
          .then((t) => {
            if (!t || typeof t.targetId !== 'string' || !t.targetId) throw new ToolError("The Host didn't open a tab.", 'failed');
            this.targetId = t.targetId;
            this.url = t.url || this.url;
            this.title = t.title || this.title;
          })
          .catch((error) => {
            // the tab never opened: the host drops it; the error goes to the call that waits on it
            this.gone();
            throw error;
          });
    this.created.catch((error) => noteIgnored('open a tab on a Host', error));
    this.navigationHistory = {
      getActiveIndex: () => this.history.currentIndex,
      length: () => this.history.entries.length,
      getEntryAtIndex: (i) => this.history.entries[i] ?? null,
      goBack: () => this.#go(-1),
      goForward: () => this.#go(1),
    };
  }

  /** The next attach waits for `work` (a detach or a Stop in flight on the Host); its failure is its own. @param {Promise<unknown>} work */
  hold(work) {
    this.settling = Promise.all([
      this.settling,
      work.catch((error) => noteIgnored('let go of a remote tab before it is taken again', error)),
    ]);
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

  /** Nothing to capture natively: the host takes screenshots through CDP. */
  capturePage() {
    return Promise.resolve(null);
  }

  /** The Host's Chromium decides how a background tab is throttled. */
  setBackgroundThrottling() {
    /* not ours to change */
  }

  reload() {
    this.#send('Page.reload', {}, 'reload a remote tab');
  }

  /** browser_navigate "stop" (hostNavigation.cjs): Chromium ends the load and keeps what the page rendered. */
  stop() {
    this.#send('Page.stopLoading', {}, 'stop a remote tab loading');
  }

  /** For assertCdpTarget: the tab still exists, and the Host answers. */
  assertDrivable() {
    if (this.destroyed)
      throw new ToolError(
        `Refusing to drive this page over CDP: it is gone${this.lostReason ? ` (${this.lostReason})` : ''}`,
        'bad_target',
      );
    if (!this.transport.alive())
      throw new ToolError(
        'The Host is unreachable, so its browser cannot be driven now. Call the tool again when the Host is back.',
        'not_connected',
      );
  }

  /** Reads the target info (URL, title, top frame), the history and the user agent again. */
  async refresh() {
    if (this.targetId == null) return;
    // each read is optional: what one cannot give keeps its last value
    const read = (method, params = {}) =>
      this.transport
        .command(this.chatId, { targetId: /** @type {string} */ (this.targetId), sessionId: '', method, params })
        .catch((error) => noteIgnored(`read ${method} of a remote tab`, error));
    const [info, hist, ua] = await Promise.all([
      read('Target.getTargetInfo'),
      read('Page.getNavigationHistory'),
      this.userAgent ? null : read('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }),
    ]);
    const t = info?.targetInfo;
    if (t) {
      this.mainFrame ??= t.targetId;
      if (typeof t.url === 'string') this.url = t.url;
      if (typeof t.title === 'string') this.title = t.title;
    }
    if (hist && Array.isArray(hist.entries)) this.history = { currentIndex: hist.currentIndex, entries: hist.entries };
    const agent = ua?.result?.value;
    if (typeof agent === 'string') this.userAgent = agent;
  }

  #refreshLater() {
    if (!this.debugger.attached) return;
    this.refresh().catch((error) => noteIgnored('read a remote tab after a navigation', error));
  }

  #go(step) {
    const entry = this.history.entries[this.history.currentIndex + step];
    if (entry) this.#send('Page.navigateToHistoryEntry', { entryId: entry.id }, 'move in the history of a remote tab');
  }

  #send(method, params, what) {
    this.debugger.sendCommand(method, params).catch((error) => noteIgnored(what, error));
  }

  /** A CDP event of this tab from the Host (its params an object, its session '' for the tab's own): the debugger's message, and the state and events the host reads. */
  event(sessionId, method, params) {
    if (!sessionId) {
      // the Host's Chromium let go of the tab's own session (a crash, a cross-process navigation): CDP must attach anew
      if (method === 'Target.detachedFromTarget') return void this.debugger.lost('target_closed');
      if (observeTabNavigation(this, method, params)) this.#refreshLater();
    }
    this.debugger.emit('message', {}, method, params, sessionId);
  }

  /** The tab closed, or the chat's browser went: the host lets go of it. @param {string} [reason] what took the tab, told to a step still naming it */
  gone(reason) {
    if (this.destroyed) return;
    if (reason) this.lostReason = reason;
    this.destroyed = true;
    this.debugger.lost('target_closed');
    this.emit('destroyed');
  }
}

module.exports = { RemoteTabContents, RemoteDebugger, isRemoteTab, ID_BASE };

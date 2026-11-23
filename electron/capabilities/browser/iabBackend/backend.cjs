// One native thread’s tab state, permissions, CDP actions and Browser Use protocol handlers.
const { noteIgnored } = require('../../../ignored.cjs');
const { sensitiveAction } = require('../siteRisk.cjs');
const { taskCovers } = require('../taskGrants.cjs');
const { botCheckRefusal, HANDOFF } = require('../botCheck.cjs');
const { FRAME_SCRIPT, FRAME_MS, withTimeout, noteUnreadable } = require('../hostUtil.cjs');
const { ToolError } = require('../../contract/registry.cjs');
const { explainRefusal } = require('../refusals.cjs');
const { guarded, stopSignal } = require('../../contract/actionGuard.cjs');
const { isHolding, releaseHeld, forgetHeld } = require('../heldInput.cjs');
const { CDP_MS, NAME, NO_PASSWORDS, UNAVAILABLE, BROWSER_CAPABILITIES, fail } = require('./protocol.cjs');
const { typingInput, keyPressed, passiveInput, childUrl, cardSummary, showInput } = require('./policy.cjs');
const { framesOf } = require('../documentScripts.cjs');
const { sizeTab, unsizeTab } = require('./viewport.cjs');
const path = require('node:path');

const { HANDLERS } = require('./handlers.cjs');

/**
 * A refusal the plugin's model can act on: a ToolError with a stable reason and next step in a <refusal> block
 * naming the in-app browser (refusals.cjs), so the chat's ways-forward strip recognizes it.
 * @param {string} code
 * @param {string} message
 * @param browser the browser it names: the in-app browser, or the user's Chrome for chromeBackend.cjs
 */
const refuse = (code, message, /** @type {'iab' | 'chrome'} */ browser = 'iab') => explainRefusal(new ToolError(message, code), browser);
/**
 * The backend of one native Codex thread: its tabs are its chat's tabs in the browser host. A subagent
 * thread's backend answers to its own thread id and works in its parent's chat (its pane tabs).
 */
class IabBackend {
  /**
   * @param {{ threadId: string, parent?: string | null, chatOf: (threadId: string) => string, tabs: () => any, grants: () => any,
   *           enabled?: () => boolean, flavor?: string | null, version?: string | null, cdpMs?: number,
   *           turns?: () => InstanceType<typeof import('../../contract/turnTokens.cjs').TurnTokens> | null }} o
   *   enabled: whether the in-app browser may be driven now (its remote switches), asked on every call
   *   turns: the `(chat, turn)` tokens (../turnTokens.cjs): each command carries its chat's turn, and acts no more once
   *   that turn ended or was stopped
   */
  constructor(o) {
    /** the browser refusals name (refusals.cjs): the in-app browser here, the user's Chrome in chromeBackend.cjs */
    /** @type {'iab' | 'chrome'} */
    this.browser = 'iab';
    this.threadId = o.threadId;
    this.turns = o.turns ?? (() => null);
    this.enabled = o.enabled ?? (() => true);
    /** the native thread whose chat this one works in (a subagent's parent), or null for a main thread */
    this.parent = o.parent ?? null;
    this.chatOf = o.chatOf;
    this.tabs = o.tabs;
    this.grants = o.grants;
    this.flavor = o.flavor ?? null;
    this.version = o.version ?? null;
    this.cdpMs = o.cdpMs ?? CDP_MS;
    /** @type {Set<InstanceType<typeof import('./wire.cjs').Peer>>} */
    this.peers = new Set();
    /** protocol tab id (an integer) <-> host tab */
    this.ids = new Map();
    this.byTab = new Map();
    this.nextId = 1;
    /** host tab -> { listener, detach, children: Map<sessionId, targetId>, screencast } while the service holds it */
    this.held = new Map();
    /** host tabs this backend opened or attached */
    this.controlled = new Set();
    this.cached = new Map();
    /** the turn the plugin's requests came from last (a turnEnded for another one is stale) */
    /** @type {string | null} */
    this.turn = null;
    /** the viewport the plugin set (browser_viewport_set), kept on the tabs it holds until it resets it */
    /** @type {{ width: number, height: number } | null} */
    this.viewport = null;
    /** tabs this backend put its viewport on */
    this.sized = new Set();
    /** the plugin asked to show the browser before this chat had a tab: the tab it opens next is shown */
    this.showNext = false;
    /** how many times the chat's calls were stopped: a command begun before the latest stop may not act */
    this.stops = 0;
    /** the signal of the requests begun since the latest stop: the next stop aborts it, withdrawing their cards (#1865) */
    this.stopping = new AbortController();
    /** stops hearing about downloads (set while a peer is connected) */
    /** @type {(() => void) | null} */
    this.offDownloads = null;
    /** stops hearing about page dialogs (set while it is loaded) */
    /** @type {(() => void) | null} */
    this.offPageEvents = null;
    /** stops hearing about the chat's Stop (set while it is loaded) */
    /** @type {(() => void) | null} */
    this.offStop = null;
  }

  /** A refusal the plugin's model can act on, naming this backend's browser (see `refuse`). */
  refuse(/** @type {string} */ code, /** @type {string} */ message) {
    return refuse(code, message, this.browser);
  }

  /** Refuses an action on a bot check (botCheck.cjs): a mouse press on one (a drag starts with one too), a key or typing. */
  refuseBotCheck(/** @type {any} */ intent, /** @type {{ kind: string }} */ action) {
    const bot = botCheckRefusal(intent, action, this.browser === 'chrome' ? HANDOFF.chrome : HANDOFF.plugin);
    if (bot) throw this.refuse('bot_check', bot.message);
  }

  /** What getInfo answers: the in-app browser backend of this thread (a subclass may serve another browser). */
  info() {
    return {
      apiSupportOverrides: { 'Browser.user': false, 'Tab.markDeliverable': true, 'Tab.markHandoff': true },
      name: NAME,
      version: this.version,
      type: 'iab',
      discoveryScope: 'session',
      blobDownloadsSupported: false,
      capabilities: { browser: BROWSER_CAPABILITIES, tab: [] },
      metadata: { ...(this.flavor ? { codexAppBuildFlavor: this.flavor } : {}), codexSessionId: this.threadId },
    };
  }

  get ctx() {
    const thread = this.parent ?? this.threadId;
    return { chatId: this.chatOf(thread), segmentId: thread };
  }

  host() {
    const t = this.tabs();
    if (!t) throw fail("MoPilot's built-in browser is not available.");
    return t;
  }

  notify(method, params) {
    for (const p of this.peers) p.notify(method, params);
  }

  /** Every request: the method's handler, after its session is checked (ping needs none) and the in-app browser is still on. */
  async handle(method, params) {
    if (method === 'ping') return 'pong';
    if (!this.on()) {
      // switched off since the thread loaded: nothing more reaches the pane
      if (method === 'moveMouse') return null;
      throw this.refuse('disabled', "MoPilot's built-in browser is turned off for agents now.");
    }
    if (method === 'moveMouse') return this.moveMouse(params);
    const p = params && typeof params === 'object' ? params : {};
    if (p.session_id !== this.threadId) throw fail(`No built-in browser route is available for browser session ${String(p.session_id)}`);
    // the turn the plugin is in: a live request names it (a cached one repeats an older turn's)
    if (method !== 'turnEnded' && typeof p.turn_id === 'string' && p.session_context !== 'cached') this.turn = p.turn_id;
    if (UNAVAILABLE.includes(method)) throw fail(`${method} is not available in MoPilot's built-in browser.`);
    const fn = HANDLERS[method];
    if (!fn) throw fail(`No handler registered for method: ${method}`);
    const turns = this.turns();
    return guarded(
      {
        // stopSignal() inside the request: the site and action cards it asks on pass it (gateUrl, gateWrite)
        signal: this.stopping.signal,
        epoch: () => this.stops,
        // its own thread's turn: a sub-agent's commands outlive another thread's turn end
        token: turns ? turns.issue(this.ctx.chatId, this.threadId) : null,
        current: turns ? (token) => turns.current(token) : null,
      },
      () => fn.call(this, p),
    );
  }

  /** The chat's calls were stopped: commands already under way act no more, and a card one waits on goes. */
  stopped() {
    this.stops++;
    this.showNext = false;
    this.stopping.abort('stopped');
    this.stopping = new AbortController();
  }

  idOf(tab) {
    if (!this.byTab.has(tab)) {
      const id = this.nextId++;
      this.byTab.set(tab, id);
      this.ids.set(id, tab);
    }
    return this.byTab.get(tab);
  }

  /** Whether the in-app browser may be driven now; a failing switch reads as off. */
  on() {
    try {
      return this.enabled() === true;
    } catch {
      return false;
    }
  }

  tabOf(id) {
    const tab = this.ids.get(id);
    if (!tab || tab.closed || tab.backend.isDestroyed()) throw fail(`Unknown tab: ${String(id)}`);
    // a popup is its opener's: a sign-in there holds the popup too
    const root = tab.kind === 'popup' && tab.root ? tab.root : tab;
    if (tab.signin || root.signin)
      throw this.refuse('signin_pending', `It is the user's turn on tab ${String(id)}. Use another tab, or end your turn.`);
    return tab;
  }

  /** Refuses when the user took over the tab, or the tab whose popup it is. */
  notTakenOver(tab) {
    const root = tab.kind === 'popup' && tab.root ? tab.root : tab;
    if (tab.takenOver || root.takenOver)
      throw this.refuse('taken_over', `The user took over tab ${this.idOf(tab)}. Don't act on it again this turn.`);
  }

  serialize(tab, current) {
    return {
      id: this.idOf(tab),
      providerTabId: tab.id,
      sessionControlled: this.controlled.has(tab),
      title: tab.title || tab.url || '',
      active: tab === current,
      url: tab.url || '',
    };
  }

  targetId(tab) {
    return `mopilot-iab-tab:${this.idOf(tab)}`;
  }

  /**
   * Site rules for `url`, asking no one: blocked, denied and read-only sites refuse; so does a write on a site allowed
   * for reading ('reask') unless `allowed` (gateUrl asks; a yes on this command's card), never without it (#1319 G22).
   */
  checkUrl(url, need, allowed = false) {
    if (!url || url === 'about:blank') return 'blank';
    const grants = this.grants();
    const ctx = this.ctx;
    const verdict = grants.peek(url, need, ctx);
    if (verdict === 'blocked') throw this.refuse('blocked', grants.blockNote(url));
    if (verdict === 'denied') throw this.refuse('denied', `The user did not allow ${new URL(url).origin} in this chat.`);
    if (verdict === 'read_only' || (verdict === 'reask' && !allowed))
      throw this.refuse(
        'read_only',
        this.anchorOf() === 'readOnly'
          ? 'This chat is in a read-only mode: browser control can only look.'
          : `${new URL(url).origin} is read only for this chat: don't click, type or change anything there.`,
      );
    return verdict;
  }

  /** The chat's browser anchor (origins.cjs), or null when it can't be read. */
  anchorOf() {
    try {
      return this.grants().anchor(this.ctx);
    } catch {
      return null;
    }
  }

  /** Site rules for `url`: refusals throw; a high-risk site (or credentials in it) asks first. True when the user said yes. */
  async gateUrl(url, need) {
    const verdict = this.checkUrl(url, need, true);
    const grants = this.grants();
    const risk = verdict === 'ask' ? grants.riskOf(url) : null;
    const asks = verdict === 'reask' || !!(risk && (risk.level === 'high' || risk.credentials));
    if (asks)
      await grants.require(url, need, { ...this.ctx, signal: stopSignal() }, { offer: 'write', localAlways: false }).catch((e) => {
        throw explainRefusal(e, this.browser);
      });
    return asks;
  }

  /**
   * The page a command is about, on every command (the vendor's backend checks it on each one too): the tab's
   * current page, and for a command sent to a child frame's session, that frame's page. Returns the pages the user said yes to.
   */
  async gatePage(tab, need, sessionId) {
    const yes = new Set((await this.gateUrl(tab.url, need)) ? [tab.url] : []);
    const child = childUrl(this.held.get(tab), sessionId);
    if (child && child !== tab.url && (await this.gateUrl(child, need))) yes.add(child);
    return yes;
  }

  /**
   * Before a write: take-over refuses, an open dialog must be answered first, password fields refuse typing, a
   * file upload asks the user, and an action on a high-risk site or a sensitive one (a submit, a payment entry,
   * a dialog accept) asks each time. `sessionId`: the frame session the command goes to ('' for the page), whose own
   * coordinates a mouse event uses: what it hits is read from there, through any cross-origin frame under it.
   */
  async gateWrite(tab, method, p, sessionId = '') {
    this.notTakenOver(tab);
    if (tab.dialog && method !== 'Page.handleJavaScriptDialog')
      throw fail(`A ${tab.dialog.type} dialog is open on tab ${this.idOf(tab)}: answer it with Page.handleJavaScriptDialog first.`);
    const url = tab.url;
    const host = this.host();
    const grants = this.grants();
    let action = /** @type {any} */ (null);
    let sensitive = /** @type {any} */ (null);
    let summary = '';
    /** what the action acts on, for host.intent: the point a mouse press is at, else the focus */
    let at = {};
    let read = null; // a mouse press's, key's or typing's target, read: "Allow for this task" may cover it (#2328)
    if (method === 'DOM.setFileInputFiles') {
      const files = (Array.isArray(p.files) ? p.files : []).map((f) => path.basename(String(f)));
      summary = `upload ${files.join(', ') || 'files'}`;
      // an upload asks each time, as browser_file_upload does, unless the chat has Full access (grants.act decides)
      sensitive = { kind: 'upload', verb: 'upload files', detail: files.join(', ').slice(0, 120) };
    } else if (method === 'Page.handleJavaScriptDialog') {
      action = { kind: 'dialog', accept: true, message: tab.dialog?.message ?? '' };
      sensitive = sensitiveAction(null, action);
    } else if (method.startsWith('Runtime.')) {
      // an accessibility action (set a value, select text) with a user gesture: typing into the focused field
      const intent = await host.intent(tab, {});
      if (intent?.secret) throw this.refuse('password_field', NO_PASSWORDS);
      this.refuseBotCheck(intent, { kind: 'type' });
      summary = 'accessibility action';
    } else if (method.startsWith('Input.')) {
      const typing = typingInput(method, p);
      const key = keyPressed(method, p);
      const press =
        method === 'Input.dispatchMouseEvent' &&
        (p.type === 'mousePressed' || (p.type === 'mouseReleased' && grants.riskOf(url).financial));
      if (press) action = { kind: 'click', target: { point: { x: p.x, y: p.y } } };
      else if (key) action = { kind: 'key', keys: key };
      else if (typing) action = { kind: 'type', text: String(p.text) };
      if (action) {
        at = press ? { point: { x: p.x, y: p.y }, session: sessionId } : {};
        const intent = (read = await host.intent(tab, at));
        if (typing && intent?.secret) throw this.refuse('password_field', NO_PASSWORDS);
        this.refuseBotCheck(intent, action);
        sensitive = sensitiveAction(intent, action);
      }
    }
    const tool = action?.kind ?? method;
    const taint = (action && grants.submitTaint?.(read, action)) || null; // a submit, which a tainted turn asks for (G3)
    if (url && url !== 'about:blank' && (sensitive || grants.tainted?.(this.ctx, url, taint) || grants.riskOf(url).level === 'high')) {
      try {
        const what = {
          tool,
          summary: summary || cardSummary(tool, url, sensitive),
          sensitive,
          ordinary: taskCovers(read, action ?? passiveInput(method, p)),
          taint,
        };
        await grants.act(url, { ...this.ctx, signal: stopSignal() }, what);
      } catch (e) {
        throw explainRefusal(e, this.browser);
      }
      // the page may have changed while the card was open: the press or key acts on what is there now
      if (action) {
        const now = await host.intent(tab, at);
        this.refuseBotCheck(now, action);
        if (taint && taint.to !== (grants.submitTaint?.(now, action)?.to ?? ''))
          throw this.refuse('page_changed', 'The form destination changed while you answered. Read the page and try again.');
        if (taskCovers(read, action) && !taskCovers(now, action))
          throw this.refuse('page_changed', 'The control changed while you answered. Read the page and try again.');
      }
    }
    if (host.o.cursor) showInput(host.o.cursor, tab, method, p);
  }

  /** Password fields masked in every frame and the agent cursor hidden (on), or put back (off). */
  async conceal(tab, on) {
    const host = this.host();
    const sessions = ['', ...tab.frames.keys()];
    // a frame that went away has nothing to mask
    const results = await Promise.all(
      sessions.map((sid) =>
        tab.agent('mask', { on }, sid).then(
          (r) => (noteUnreadable(r, 'the browser plugin'), r),
          (error) => noteIgnored(`${on ? 'mask' : 'unmask'} password fields in a frame for the browser plugin`, error),
        ),
      ),
    );
    if (on && results.some((r) => r?.count > 0))
      await withTimeout(
        tab.send('Runtime.evaluate', { expression: FRAME_SCRIPT, awaitPromise: true, returnByValue: true }).catch((error) =>
          // masking is already applied; the paint wait is best effort
          noteIgnored('wait for a frame painted with password fields masked', error),
        ),
        FRAME_MS,
        () => null,
      );
    if (host.o.cursor) await (on ? host.o.cursor.conceal(tab) : host.o.cursor.reveal(tab));
  }

  /** Starts forwarding the tab's CDP events to the service. */
  async hold(tab) {
    this.controlled.add(tab);
    if (this.held.has(tab)) {
      // a tab whose renderer came back (reloaded after a crash) gets the viewport it could not take then
      if (this.viewport && !this.sized.has(tab)) await this.size(tab);
      return;
    }
    await tab.attach();
    tab.hold();
    const dbg = tab.backend.debugger;
    /** @type {{ children: Map<string, string>, urls: Map<string, string>, screencast: boolean, listener: any, detach: any }} */
    const h = { children: new Map(), urls: new Map(), screencast: false, listener: null, detach: null };
    h.listener = (_e, method, params, sessionId) => {
      const id = this.idOf(tab);
      let source = { tabId: id };
      if (sessionId) {
        if (!h.children.has(sessionId)) return;
        source = { tabId: id, sessionId, targetId: h.children.get(sessionId) };
        // a child frame's own page, which commands sent to its session are about
        if (method === 'Page.frameNavigated' && !params?.frame?.parentId && typeof params?.frame?.url === 'string')
          h.urls.set(sessionId, params.frame.url);
      }
      if (method === 'Target.attachedToTarget' && params?.sessionId) {
        h.children.set(params.sessionId, params.targetInfo?.targetId ?? '');
        if (typeof params.targetInfo?.url === 'string') h.urls.set(params.sessionId, params.targetInfo.url);
      } else if (method === 'Target.detachedFromTarget') {
        h.children.delete(params?.sessionId);
        h.urls.delete(params?.sessionId);
      }
      this.notify('onCDPEvent', { source, method, params });
    };
    h.detach = () => this.drop(tab, false);
    dbg.on('message', h.listener);
    dbg.on('detach', h.detach);
    // frames the page's debugger attached before (documentScripts.cjs) are not reported again
    for (const f of framesOf(tab.backend)) {
      h.children.set(f.sessionId, f.targetId);
      if (f.url) h.urls.set(f.sessionId, f.url);
    }
    this.held.set(tab, h);
    // the plugin's viewport override reaches every tab it holds
    if (this.viewport && !this.sized.has(tab)) await this.size(tab);
  }

  /** Puts the plugin's viewport on a tab it holds (viewport.cjs). */
  size(tab) {
    return sizeTab(this, tab);
  }

  /** Takes the plugin's viewport off a tab (viewport.cjs). */
  unsize(tab) {
    return unsizeTab(this, tab);
  }

  /**
   * Something happened on a page of a tab the plugin holds (BrowserTabs.onPageEvent). A page's own dialog
   * (pageDialogs.cjs) opening or closing reaches it as CDP's dialog events, and it answers with
   * Page.handleJavaScriptDialog as it would a native one (handlers.cjs); MoPilot's own events (a blocked app link,
   * as Page.navigationBlocked like the backend's URL policy) reach it as they are.
   * @param {{ tab: any, open?: boolean, dialog?: { type: string, message: string, defaultPrompt: string, url: string },
   *           result?: { accept: boolean, value: unknown }, cdp?: { method: string, params: any } }} change
   */
  pageEvent({ tab, open, dialog, result, cdp }) {
    if (!this.held.has(tab)) return;
    const source = { tabId: this.idOf(tab) };
    if (cdp) return void this.notify('onCDPEvent', { source, method: cdp.method, params: cdp.params });
    const frameId = this.targetId(tab);
    const d = /** @type {{ type: string, message: string, defaultPrompt: string, url: string }} */ (dialog);
    if (open)
      this.notify('onCDPEvent', {
        source,
        method: 'Page.javascriptDialogOpening',
        params: {
          url: d.url,
          frameId,
          message: d.message,
          type: d.type,
          hasBrowserHandler: true,
          defaultPrompt: d.defaultPrompt,
        },
      });
    else
      this.notify('onCDPEvent', {
        source,
        method: 'Page.javascriptDialogClosed',
        params: { frameId, result: !!result?.accept, userInput: typeof result?.value === 'string' ? result.value : '' },
      });
  }

  /** A download a tab this backend controls saved: the plugin waits on these (onDownloadChange). */
  downloaded({ tab, id, url, filename, status }) {
    if (!this.controlled.has(tab)) return;
    this.notify('onDownloadChange', { id, session_id: this.threadId, status, tabId: this.idOf(tab), url, filename });
  }

  /**
   * Stops forwarding (the service detached, the turn ended, or the debugger went): the plugin's request
   * interception is switched off so the page never waits on it, and a screencast's mask comes off.
   */
  drop(tab, live = true) {
    const h = this.held.get(tab);
    if (!h) return;
    this.held.delete(tab);
    const dbg = tab.backend.isDestroyed() ? null : tab.backend.debugger;
    if (dbg) {
      dbg.removeListener('message', h.listener);
      dbg.removeListener('detach', h.detach);
    }
    if (live && dbg && dbg.isAttached()) {
      for (const sid of ['', ...h.children.keys()])
        (sid ? dbg.sendCommand('Fetch.disable', {}, sid) : dbg.sendCommand('Fetch.disable', {})).catch((error) =>
          noteIgnored("switch off the browser plugin's request interception", error),
        );
      if (h.screencast)
        void this.conceal(tab, false).catch((error) => noteIgnored("unmask a tab after the browser plugin's screencast", error));
      // nothing the plugin pressed stays down after it lets go of the tab (releaseHeld names a child session only
      // when the key went down there, and notes its own failures)
      if (isHolding(tab)) void releaseHeld(tab, (...command) => dbg.sendCommand(...command));
    }
    // what could not be let go of (the debugger is gone) went with the page's input state
    forgetHeld(tab);
    this.notify('onCDPDetach', { tabId: this.idOf(tab) });
  }

  async emulated(tab, method, p, target) {
    const own = this.targetId(tab);
    if (method === 'Target.getTargetInfo') {
      if (
        target.sessionId != null ||
        (target.targetId != null && target.targetId !== own) ||
        (p.targetId !== undefined && p.targetId !== own)
      )
        throw fail("Target.getTargetInfo can only read the current tab of MoPilot's built-in browser.");
      return { targetInfo: this.targetInfo(tab) };
    }
    if (method === 'Target.getTargets') {
      const host = this.host();
      const tabs = host.list(this.ctx.chatId).map((t) => this.targetInfo(t));
      const frames = [...(this.held.get(tab)?.children || new Map())].map(([, targetId]) => ({
        targetId,
        type: 'iframe',
        attached: true,
        tabId: this.idOf(tab),
      }));
      return { targetInfos: [...tabs, ...frames] };
    }
    if (p.targetId !== own) throw fail("Target.closeTarget can only close the current tab of MoPilot's built-in browser.");
    this.drop(tab);
    await this.host().close(this.ctx.chatId, tab.id);
    return { success: true };
  }

  targetInfo(tab) {
    const id = this.targetId(tab);
    return {
      targetId: id,
      id,
      tabId: this.idOf(tab),
      type: 'page',
      title: tab.title,
      url: tab.url,
      attached: this.held.has(tab),
      canAccessOpener: false,
    };
  }

  async moveMouse(params) {
    const p = params && typeof params === 'object' ? params : {};
    const tab = this.ids.get(p.tabId);
    if (!tab || tab.closed || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    await this.host().o.cursor?.act(tab, { kind: 'hover', x: p.x, y: p.y });
    return null;
  }
}

module.exports = { IabBackend };

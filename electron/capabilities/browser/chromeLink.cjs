// One chat's Chrome extension transport: tab events, command replies, timeouts and connection cleanup.
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');

const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const EXTENSION_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;
const CONNECT_PAGE = `${EXTENSION_ORIGIN}/connect.html`;
const validReceipt = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;
/** The one detach reason that loses only the debugger, as the extension keeps the tab for it (sessions.mjs onDebuggerDetach); any other takes the tab. */
const KEEPS_TAB = 'target_closed';
const retiredMembership = () => new ToolError('This Chrome tab membership was retired. List this chat’s tabs again.', 'bad_target');

const linkGone = () =>
  new ToolError(
    "Your Chrome disconnected from this chat. Call the tool again to reconnect (Chrome asks if it needs the user's approval).",
    'not_connected',
  );

/** One chat's connection to the extension: its tabs, commands in flight and events. */
class ChromeLink extends EventEmitter {
  /** @param {string} chatId @param {any} ws a WsConnection @param {number} commandMs */
  constructor(chatId, ws, commandMs, { memberships = false } = {}) {
    super();
    this.chatId = chatId;
    this.ws = ws;
    this.commandMs = commandMs;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, method: string, started: number }>} */
    this.pending = new Map();
    /** tab id -> the tab as the extension reported it (chrome.tabs.Tab) */
    this.tabs = new Map();
    /** tab id -> what took it from the chat ('closed', 'canceled_by_user', 'removed_from_group'), until it is reported again */
    this.lost = new Map();
    this.membershipReceipts = memberships;
    this.memberships = new Map();
    this.tabSequence = 0;
    this.tabVersions = new Map();
    /** the connect page's tab, until a tab of the chat takes it over */
    this.connectTab = null;
    this.initialized = false;
    this.closed = false;
    /**
     * Whether the chat's tabs outlive this connection: set when it closed only because the extension's own connection
     * dropped (MoPilot's extension keeps the chat's session and reports its tabs again on the next one). Never
     * when MoPilot closed it (the chat was deleted, the app quits), nor for the Playwright Extension, whose next
     * connection reports none of the old one's tabs.
     */
    this.resumable = false;
    ws.on('message', (text) => this.#message(text));
    ws.on('close', (_code, reason) => this.#closed(reason || 'closed'));
  }

  get open() {
    return !this.closed && this.ws.open;
  }

  #message(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch (error) {
      noteIgnored('parse a message from the Playwright Extension', error);
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error !== undefined) p.reject(new ToolError(`Chrome refused ${p.method}: ${String(m.error?.message ?? m.error)}`, 'failed'));
      else if (this.membershipReceipts && p.method === 'chrome.tabs.create') {
        const tab = this.#reported(m.result, { membership: m.result?.membership }, p.started);
        if (tab) p.resolve(tab);
        else p.reject(retiredMembership());
      } else p.resolve(m.result);
      return;
    }
    const params = Array.isArray(m.params) ? m.params : [];
    switch (m.method) {
      case 'extension.initialized':
        this.initialized = true;
        this.emit('ready');
        break;
      case 'chrome.tabs.onCreated': {
        const tab = this.#reported(params[0], params[1]);
        if (!tab) break;
        if (typeof tab.url === 'string' && tab.url.startsWith(CONNECT_PAGE) && this.connectTab == null) this.connectTab = tab.id;
        this.emit('tab', tab);
        break;
      }
      case 'chrome.tabs.onRemoved': {
        const tabId = params[0];
        if (!this.#revoked(tabId, params[1])) break;
        if (this.connectTab === tabId) this.connectTab = null;
        this.emit('removed', tabId);
        break;
      }
      case 'chrome.debugger.onEvent': {
        const [source, method, cdpParams] = params;
        if (!source || !Number.isSafeInteger(source.tabId) || source.tabId < 0 || typeof method !== 'string') break;
        if (
          this.membershipReceipts &&
          (!validReceipt(params[3]?.membership) || this.memberships.get(source.tabId)?.membership !== params[3].membership)
        )
          break;
        this.emit('cdp', source, method, cdpParams || {});
        break;
      }
      case 'chrome.tabs.onActivated': {
        // MoPilot's own extension: the user brought one of the chat's tabs to the front
        if (Number.isInteger(params[0])) this.emit('activated', params[0]);
        break;
      }
      case 'chrome.downloads.onChanged': {
        // MoPilot's own extension: a download the chat's agent started in its tab (chrome-extension/src/downloads.mjs)
        const d = params[0];
        if (d && Number.isInteger(d.tabId) && Number.isInteger(d.id)) this.emit('download', d);
        break;
      }
      case 'chrome.debugger.onDetach': {
        const [source, reason] = params;
        if (!source || !Number.isInteger(source.tabId)) break;
        const why = String(reason || '');
        // Only the debugger went (Chrome force-detached it for another extension's frame in the page, frameGuard.mjs): the
        // tab stays the chat's until chrome.tabs.onRemoved, as the extension keeps it (sessions.mjs onDebuggerDetach), and
        // the next step attaches again (#2325).
        if (why === KEEPS_TAB) {
          if (this.#current(source.tabId, params[2])) this.emit('detach', source.tabId, why);
          break;
        }
        // any other reason takes the tab, as the extension drops it: the user took it back (dragged it out of the group,
        // closed the debugging bar). It is no longer the chat's until the extension reports it again (chrome.tabs.onCreated)
        if (!this.#revoked(source.tabId, params[2], why)) break;
        this.emit('detach', source.tabId, why);
        break;
      }
      default:
    }
  }

  /** Decode ownership before resolving a creation promise: later events must win before its microtask runs. */
  #reported(tab, proof, started = /** @type {number | null} */ (null)) {
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) return null;
    /** @type {{ membership: string, manual: boolean } | null} */
    let metadata = null;
    if (this.membershipReceipts) {
      if (!validReceipt(proof?.membership)) return null;
      const ownership = proof.ownership;
      if (
        ownership !== undefined &&
        (ownership?.kind !== 'user_group' ||
          !Number.isSafeInteger(ownership.groupId) ||
          ownership.groupId < 0 ||
          ownership.groupId !== tab.groupId)
      )
        return null;
      if (
        started !== null &&
        (this.tabVersions.get(tab.id) ?? 0) > started &&
        this.memberships.get(tab.id)?.membership !== proof.membership
      )
        return null;
      metadata = { membership: proof.membership, manual: ownership !== undefined };
      this.memberships.set(tab.id, metadata);
      this.tabVersions.set(tab.id, ++this.tabSequence);
    }
    // Never treat a property of the native Tab as authenticated manual-admission provenance.
    const { membership: _untrusted, ...native } = tab;
    const owned = { ...native, ...(metadata ? { membership: metadata.membership } : {}) };
    this.tabs.set(tab.id, owned);
    this.lost.delete(tab.id);
    return owned;
  }

  /** Whether an event's receipt names the tab's current membership (any, without receipts). */
  #current(tabId, proof) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
    return !this.membershipReceipts || (validReceipt(proof?.membership) && this.memberships.get(tabId)?.membership === proof.membership);
  }

  /**
   * Unknown ids still leave an observation tombstone for a pending creation reply. `why`: what took the tab (a
   * detach reason, or 'closed'), kept so a step still naming it is told (lostReason).
   */
  #revoked(tabId, proof, why = 'closed') {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;
    if (this.membershipReceipts) {
      if (!validReceipt(proof?.membership)) return false;
      const current = this.memberships.get(tabId);
      if (current && current.membership !== proof.membership) return false;
      this.tabVersions.set(tabId, ++this.tabSequence);
      this.memberships.delete(tabId);
    }
    if (this.tabs.delete(tabId)) this.lost.set(tabId, why);
    return true;
  }

  /**
   * Sends a command and waits for its answer, at most commandMs.
   * @param {string} method @param {any[]} params
   * @param {Record<string, unknown> | null} [extra] more fields for the frame (MoPilot's own extension reads the turn)
   */
  send(method, params, extra = null) {
    if (!this.open) return Promise.reject(linkGone());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError(`Chrome did not answer ${method} within ${Math.round(this.commandMs / 1000)} s.`, 'timeout'));
      }, this.commandMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method, started: this.tabSequence });
      this.ws.send(JSON.stringify({ ...extra, id, method, params }));
    });
  }

  close(reason) {
    this.ws.close(1000, reason);
    this.#closed(reason);
  }

  #closed(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(linkGone());
    }
    this.pending.clear();
    this.emit('closed', reason);
  }
}

module.exports = { ChromeLink, linkGone, retiredMembership, EXTENSION_ID, EXTENSION_ORIGIN, EXTENSION_URL, CONNECT_PAGE };

// A chat's browser tabs are owned by (hostId, chatId): one BrowserTabs for this Mac and one RemoteTabs per Host (design/host/index.html, package 3.4).
//
// - The Host a call goes to is resolved when the call arrives, from the chat's ownership record, never captured when a thread or turn started
//   (docs/control-plane/design.md, failure class 1). A tool call on a Tab goes to the BrowserTabs that made the Tab.
// - A continue moves the chat, not its tabs: the tabs stay on the source Host, listed under their Host in the chat's leases, and the target
//   starts with none. The source's tabs are let go of when that Host's own turn ended and are closed once the chat stayed away for idleMs.
// - A turn end lets go only on the Hosts the turn acted on (plus this Mac for a chat that lives here), so the end of a turn that ran on the
//   source Host never touches the tabs the chat opened on the target meanwhile.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { LOCAL_HOST } = require('./hostTabKey.cjs');

/** How long a chat's tabs stay on a Host it moved away from before they are closed (as a Your Chrome chat's, chromeHost.cjs CHAT_IDLE_MS). */
const RELEASED_IDLE_MS = 10 * 60_000;

/** The calls that pick the tab an agent works on: they follow the Host that runs the chat now, and the rest of the turn stays on the Host they reached. */
const ACQUIRES = new Set(['resolve', 'create']);

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */

class TabsByHost {
  /**
   * @param {object} o
   * @param {BrowserTabs} o.local this Mac's tabs
   * @param {(chatId: string) => string} o.ownerOf the Host that runs the chat now (the ownership record; 'local' for a chat nobody moved)
   * @param {(hostId: string) => BrowserTabs | null | undefined} [o.make] one RemoteTabs for a Host (remoteBrowserTabs), or nothing while that Host has no browser service
   * @param {number} [o.idleMs] @param {typeof setTimeout} [o.setTimer] @param {typeof clearTimeout} [o.clearTimer]
   */
  constructor({ local, ownerOf, make = () => null, idleMs = RELEASED_IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.ownerOf = ownerOf;
    this.make = make;
    this.idleMs = idleMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** host id -> its tabs, this Mac first @type {Map<string, BrowserTabs>} */
    this.hosts = new Map([[LOCAL_HOST, local]]);
    /** tabs -> the Host it serves @type {Map<BrowserTabs, string>} */
    this.ids = new Map([[local, LOCAL_HOST]]);
    /** chat id -> the Hosts its agent acted on since the chat's last turn end @type {Map<string, Set<string>>} */
    this.touched = new Map();
    /** chat id -> the Host its agent last picked a tab on this turn: the calls that follow stay there if the chat moves meanwhile @type {Map<string, string>} */
    this.acted = new Map();
    /** chat id -> the Host that ran it when last looked at @type {Map<string, string>} */
    this.last = new Map();
    /** (host, chat) -> the timer that closes tabs left on a Host the chat moved away from @type {Map<string, any>} */
    this.reaping = new Map();
  }

  /** This Mac's tabs. */
  get local() {
    return /** @type {BrowserTabs} */ (this.hosts.get(LOCAL_HOST));
  }

  /** The tabs of a Host that has some, or null; never makes one. */
  existing(/** @type {string} */ hostId) {
    return this.hosts.get(hostId) ?? null;
  }

  /** Every Host with tabs, as [hostId, tabs]. */
  entries() {
    return [...this.hosts];
  }

  /** The tabs of a Host, made on first use. A Host without a browser service refuses the call, saying so. */
  forHost(/** @type {string} */ hostId) {
    const known = this.hosts.get(hostId);
    if (known) return known;
    const made = this.make(hostId);
    if (!made) throw new ToolError('The browser is not available on this chat’s Host right now.', 'host_unavailable');
    this.hosts.set(hostId, made);
    this.ids.set(made, hostId);
    return made;
  }

  /** A Host went away (unregistered, or its connection ended for good): its tabs are let go of here, and the next call makes new ones. */
  dropHost(/** @type {string} */ hostId) {
    const tabs = this.hosts.get(hostId);
    if (!tabs || hostId === LOCAL_HOST) return;
    this.hosts.delete(hostId);
    this.ids.delete(tabs);
    for (const key of [...this.reaping.keys()]) if (JSON.parse(key)[0] === hostId) this.unreap(key);
    for (const set of this.touched.values()) set.delete(hostId);
    /** @type {any} */ (tabs).dispose?.();
  }

  /**
   * The Host that runs the chat now. Seeing it change starts the countdown for the tabs left on the Host it left, and seeing it come
   * back ends that countdown.
   */
  owner(/** @type {string} */ chatId) {
    const now = this.ownerOf(chatId);
    const before = this.last.get(chatId);
    this.last.set(chatId, now);
    this.unreap(this.reapKey(now, chatId));
    if (before !== undefined && before !== now) this.reapLater(before, chatId);
    return now;
  }

  /** Looks at every chat again: the tabs of those that moved start their countdown. Called when ownership changes. */
  noticeAll() {
    for (const chatId of [...this.last.keys()]) this.owner(chatId);
  }

  /** The tabs of the Host that runs the chat now. */
  tabsOf(/** @type {string} */ chatId) {
    return this.forHost(this.owner(chatId));
  }

  reapKey(/** @type {string} */ hostId, /** @type {string} */ chatId) {
    return JSON.stringify([hostId, chatId]);
  }

  unreap(/** @type {string} */ key) {
    const timer = this.reaping.get(key);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.reaping.delete(key);
  }

  /** The chat left `hostId`: its tabs there close once it stayed away. This Mac's are the user's (a deliverable stays open) and are not reaped. */
  reapLater(/** @type {string} */ hostId, /** @type {string} */ chatId) {
    if (hostId === LOCAL_HOST || !this.existing(hostId)?.list(chatId).length) return;
    const key = this.reapKey(hostId, chatId);
    this.unreap(key);
    const timer = this.setTimer(() => {
      this.reaping.delete(key);
      this.existing(hostId)?.forget(chatId);
    }, this.idleMs);
    timer.unref?.();
    this.reaping.set(key, timer);
  }

  touch(/** @type {string} */ chatId, /** @type {string} */ hostId) {
    const set = this.touched.get(chatId);
    if (set) set.add(hostId);
    else this.touched.set(chatId, new Set([hostId]));
  }

  /**
   * The tabs a call reaches: a chat id goes to the Host that runs the chat now when the call picks a tab, and otherwise to the Host the
   * turn last picked one on (a continue mid-action does not move the step that is running); a Tab goes to the tabs that made it, anything
   * else to this Mac. A chat id reaching a Host marks it as acted on, for the turn end.
   * @param {unknown} first the call's first argument @param {string} method
   */
  routeOf(first, method) {
    if (typeof first === 'string' && first) {
      const sticky = ACQUIRES.has(method) ? undefined : this.acted.get(first);
      const tabs = (sticky !== undefined && this.hosts.get(sticky)) || this.tabsOf(first);
      const hostId = /** @type {string} */ (this.ids.get(tabs));
      if (ACQUIRES.has(method)) this.acted.set(first, hostId);
      this.touch(first, hostId);
      return tabs;
    }
    const made = /** @type {any} */ (first)?.host;
    return this.ids.has(made) ? made : this.local;
  }

  /**
   * A BrowserTabs for the browser_* tools that routes each call as routeOf says, so the tools stay unaware of Hosts. Turn end, forget and
   * leases are the router's own, as they span every Host the chat has tabs on.
   * @returns {BrowserTabs}
   */
  routed() {
    const router = this;
    const own = new Set(['turnEnded', 'forget', 'leases', 'onTurnEnd']);
    return new Proxy(this.local, {
      get(local, prop) {
        if (prop === 'localDataAllowed') return (chatId, tab) => router.owner(chatId) === LOCAL_HOST && (!tab || tab.host === router.local);
        const value = /** @type {any} */ (local)[prop];
        if (typeof value !== 'function') return value;
        if (typeof prop === 'string' && own.has(prop)) return (/** @type {any} */ arg) => /** @type {any} */ (router)[prop](arg);
        return (/** @type {any[]} */ ...args) => {
          const tabs = /** @type {any} */ (router.routeOf(args[0], String(prop)));
          return tabs[prop](...args);
        };
      },
    });
  }

  /** The chat's tabs on every Host, each lease saying which Host it is on: a tab id means nothing on another Host. */
  leases(/** @type {string} */ chatId) {
    this.owner(chatId);
    return [...this.hosts].flatMap(([hostId, tabs]) => {
      try {
        return tabs.leases(chatId).map((l) => ({ ...l, hostId }));
      } catch (error) {
        noteIgnored('list the tabs a chat holds on a Host', error);
        return [];
      }
    });
  }

  /** Listens for the end of any chat's turn, wherever the chat runs: the listeners live on this Mac's tabs, and a turn that ran on a Host reaches them from `turnEnded` below. */
  onTurnEnd(/** @type {(chatId: string) => void} */ fn) {
    return this.local.onTurnEnd(fn);
  }

  /** The chat's turn ended: the Hosts its agent acted on let go, and this Mac too while the chat lives here. */
  async turnEnded(/** @type {string} */ chatId) {
    const hosts = this.touched.get(chatId) ?? new Set();
    this.touched.delete(chatId);
    this.acted.delete(chatId);
    if (this.owner(chatId) === LOCAL_HOST) hosts.add(LOCAL_HOST);
    // each Host in its own async step: one that throws before it returns a promise does not keep the others from letting go
    const ended = await Promise.allSettled([...hosts].map(async (hostId) => this.existing(hostId)?.turnEnded(chatId)));
    for (const r of ended) if (r.status === 'rejected') noteIgnored('let go of a chat’s tabs on a Host at a turn end', r.reason);
    // what the tools keep per turn (script sessions, snapshots, approvals, grants) is this Mac's whatever Host ran the chat; this Mac's own turn end already told its listeners
    if (!hosts.has(LOCAL_HOST))
      for (const fn of [...(this.local.turnEndListeners ?? [])])
        try {
          fn(chatId);
        } catch (error) {
          noteIgnored('tell a listener the turn ended', error);
        }
  }

  /** The chat ended (deleted, archived, cleared): its tabs on every Host go. */
  forget(/** @type {string} */ chatId) {
    this.touched.delete(chatId);
    this.acted.delete(chatId);
    this.last.delete(chatId);
    for (const [hostId, tabs] of this.hosts) {
      this.unreap(this.reapKey(hostId, chatId));
      try {
        tabs.forget(chatId);
      } catch (error) {
        noteIgnored('close a finished chat’s tabs on a Host', error);
      }
    }
  }

  /** Stops following every Host. */
  dispose() {
    for (const timer of this.reaping.values()) this.clearTimer(timer);
    this.reaping.clear();
    for (const hostId of [...this.hosts.keys()]) this.dropHost(hostId);
  }
}

module.exports = { TabsByHost, RELEASED_IDLE_MS };

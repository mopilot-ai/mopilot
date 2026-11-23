// The extension's per-chat sessions (design D5, B2 step 2): each MoPilot chat gets its own tab group, and commands reach only that chat's tabs.
//
// MoPilot sends the Chrome relay's commands (chrome.debugger.attach, detach and sendCommand,
// chrome.tabs.create and remove), each with the chat it is for and that chat's turn, plus four of its own:
// session.open (a chat starts using Chrome), session.close (the chat is gone: its tabs leave the group and are
// the user's again), session.advance (the chat's turn ended or was stopped) and session.status (groups.mjs status). It reads the same events the
// Playwright Extension forwards (chrome.debugger.onEvent and onDetach, chrome.tabs.onCreated and onRemoved,
// extension.initialized), each tagged with its chat.
// - A chat owns the tabs it created, popups they opened and tabs the user dragged into its group. A command
//   naming any other tab is refused here as well as in main, so the user's own tabs are never reached.
// - A popup is the chat's by the tab Chrome says opened it (webNavigation.onCreatedNavigationTarget's sourceTabId).
//   A tab's openerTabId is not that: Chrome sets it to the window's active tab, while a chat's tab is usually a
//   hidden one, so a link the agent clicks there names the user's tab (#1642). Without that report (`sourcedPopups`
//   off) the opener is all there is.
// - A tab the user drags out of the group, or whose debugging bar the user cancels, stops being the chat's:
//   its debugger is let go and MoPilot is told (chrome.debugger.onDetach), as with the relay.
// - Turns: a command carrying an older turn than the chat's latest is refused (main refuses it first; this
//   covers commands already on their way when the turn ended). Letting go (detach, closing a tab) never is.
// - When MoPilot goes away every debugger is let go, so the user's Chrome keeps no debugging bar, and the
//   groups stay, to be used again when it reconnects. What a chat holds is kept in chrome.storage.session, so a
//   service worker restart keeps the groups and the chats' tabs (reported again when each chat's session opens);
//   the debuggers the stopped worker held are let go, as when MoPilot goes away.

import { Debuggers } from './debuggers.mjs';
import { Groups } from './groups.mjs';
import { tabOpener } from './openTab.mjs';
import { SessionAdmissions } from './sessionAdmissions.mjs';

/** Commands that only let go: never refused for a stale turn. */
export const RELEASES = new Set(['chrome.debugger.detach', 'chrome.tabs.remove']);
export { GROUP_COLOR } from './groups.mjs';
const STORE_KEY = 'sessions';
const validReceipt = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;
const validTab = (id) => Number.isSafeInteger(id) && id >= 0;
const validGroup = (id) => Number.isSafeInteger(id) && id >= 0;
/** A new tab may only open on a page that carries no privilege: the agent navigates it afterwards, under main's checks. */
const OPENABLE = /^(?:about:blank$|https?:\/\/)/;

/**
 * @typedef {{ id: string, manual: boolean, groupId: number | null }} Membership
 * @typedef {{ title: string, groupId: number | null, tabs: Set<number>, attached: Set<number>, turn: number, receipts?: boolean, status?: string | null }} Session
 */

export class Sessions {
  /**
   * @param {{ chrome: any, send: (message: any) => void, storage?: { get: (k: string) => Promise<any>, set: (v: any) => Promise<void> } | null,
   *           log: (what: string, error: unknown) => void, sourcedPopups?: boolean }} o
   *   send: a message to MoPilot (dropped while it is not connected); sourcedPopups: onNavigationTarget reports
   *   popups (the worker follows webNavigation), so a created tab's openerTabId adopts nothing
   */
  constructor(o) {
    this.chrome = o.chrome;
    this.sourcedPopups = !!o.sourcedPopups;
    this.send = o.send;
    this.storage = o.storage ?? null;
    this.log = o.log;
    /** opens a tab, in a new unfocused window when Chrome has none open (#3714) */
    this.openTab = tabOpener(this.chrome, this.log);
    /** @type {Map<string, Session>} */
    this.chats = new Map();
    /** tab id -> the chat that owns it */
    this.owner = new Map();
    /** @type {Map<number, Membership>} exact ownership, separate from the untrusted Chrome Tab payload */
    this.memberships = new Map();
    this.saveTail = Promise.resolve();
    this.groups = new Groups({ chrome: this.chrome, changed: () => this.#save(), log: this.log, owns: (id) => this.owner.has(id) });
    this.grouping = this.groups.active;
    this.admissions = new SessionAdmissions(this, {
      own: (chat, session, tabId) => this.#own(chat, session, tabId),
      release: (chat, tabId, reason) => this.#release(chat, tabId, reason),
      report: (chat, session, tab) => this.#report(chat, session, tab),
      save: () => this.#save(),
    });
    this.debuggers = new Debuggers({ chrome: this.chrome, changed: () => this.#save(), log: this.log });
  }

  /** The chats kept across a service worker restart. */
  async restore() {
    if (!this.storage) return;
    let saved;
    try {
      saved = (await this.storage.get(STORE_KEY))?.[STORE_KEY];
    } catch (error) {
      this.log('read the saved sessions', error);
      return;
    }
    if (!saved || typeof saved !== 'object') return;
    /** debuggers the stopped worker held: MoPilot's connection went with that worker, so nobody drives them */
    const held = [];
    for (const [chat, s] of Object.entries(saved)) {
      const tabs = new Set((Array.isArray(s?.tabs) ? s.tabs : []).filter((id) => validTab(id) && !this.owner.has(id)));
      this.chats.set(chat, {
        title: String(s?.title || 'MoPilot'),
        groupId: validGroup(s?.groupId) ? s.groupId : null,
        tabs,
        attached: new Set(),
        turn: 0,
      });
      for (const t of tabs) this.#own(chat, this.#session(chat), t, s?.memberships?.[t], true);
      for (const t of Array.isArray(s?.attached) ? s.attached : []) if (tabs.has(t)) held.push([this.#session(chat), t]);
    }
    // let go of them as when MoPilot goes away (peerGone), so the chat's next attach starts clean instead of
    // finding its own old debugger on the tab
    await Promise.all(
      held.map(([s, tabId]) =>
        this.debuggers.restore(s, tabId).catch((error) => this.log('let go of a tab the stopped worker held', error)),
      ),
    );
    if (held.length) this.#save();
  }

  #save() {
    const storage = this.storage;
    if (!storage) return;
    const out = {};
    for (const [chat, s] of this.chats)
      out[chat] = {
        title: s.title,
        groupId: s.groupId,
        tabs: [...s.tabs],
        attached: [...s.attached],
        memberships: Object.fromEntries([...s.tabs].map((id) => [id, { ...this.memberships.get(id) }])),
      };
    // Receipt-bearing snapshots must reach storage in order, including after a rejected predecessor.
    this.saveTail = this.saveTail.then(() => storage.set({ [STORE_KEY]: out })).catch((error) => this.log('save the sessions', error));
  }

  /**
   * One message from MoPilot (it has a `chat`): a session message, or a command answered by its id.
   * @param {{ chat: string, id?: number, method: string, params?: any[], turn?: number, membership?: unknown }} m
   * @param {(message: any) => void} reply @param {boolean} receipts mutually negotiated for this peer
   */
  async handle(m, reply = this.send, receipts = false) {
    const params = Array.isArray(m.params) ? m.params : [];
    if (m.method === 'session.open') return this.open(m.chat, { ...(params[0] ?? {}), receipts });
    if (m.method === 'session.close') return this.close(m.chat);
    if (m.method === 'session.advance') return this.advance(m.chat, params[0]);
    if (m.method === 'session.status') return this.groups.status(this.chats.get(m.chat), params[0], () => this.#save());
    if (m.id === undefined) return;
    try {
      const result = await this.command(m.chat, m.method, params, m.turn, receipts ? m.membership : undefined, receipts);
      this.admissions.assertReceipt(m.method, result, receipts);
      reply({ chat: m.chat, id: m.id, result: result ?? {} });
    } catch (error) {
      reply({ chat: m.chat, id: m.id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /**
   * A chat starts using Chrome: its session, and the tabs it still has (after a reconnect), then extension.initialized.
   * @param {string} chat @param {{ title?: string, turn?: number, receipts?: boolean, status?: unknown }} o
   */
  async open(chat, { title, turn, receipts = false, status }) {
    let s = this.chats.get(chat);
    if (!s) {
      s = { title: String(title || 'MoPilot'), groupId: null, tabs: new Set(), attached: new Set(), turn: 0 };
      this.chats.set(chat, s);
    } else if (title) s.title = String(title);
    s.receipts = receipts;
    if (status !== undefined) this.groups.status(s, { status }, () => undefined); // the turn the chat is in (its group's mark)
    // MoPilot's count of the chat's turns: after it restarts it counts from 0 again
    if (Number.isInteger(turn)) s.turn = /** @type {number} */ (turn);
    for (const tabId of [...s.tabs]) {
      if (!this.#holds(chat, s, tabId)) continue;
      const membership = this.#membership(tabId);
      const current = () => this.#holds(chat, s, tabId) && this.memberships.get(tabId) === membership;
      try {
        const tab = await this.chrome.tabs.get(tabId);
        if (!current()) continue;
        if (
          tab?.id !== tabId ||
          (membership.groupId != null && tab.groupId !== membership.groupId) ||
          (membership.manual && membership.groupId !== s.groupId)
        )
          this.#release(chat, tabId, 'removed_from_group');
        else this.#report(chat, s, tab);
      } catch {
        // closed while MoPilot was away, unless another session owns it now
        if (current()) this.#drop(chat, tabId);
      }
    }
    if (this.chats.get(chat) !== s) return;
    this.#save();
    this.send({ chat, method: 'extension.initialized', params: [] });
  }

  /** The chat is gone: its debuggers let go, its tabs leave the group and are the user's again. */
  async close(chat) {
    const s = this.chats.get(chat);
    if (!s) return;
    this.chats.delete(chat);
    const tabs = [...s.tabs];
    // Retire ownership before Chrome can report removals or a replacement session can adopt the tabs.
    for (const tabId of tabs) {
      this.owner.delete(tabId);
      this.memberships.delete(tabId);
      this.grouping.delete(tabId);
    }
    await Promise.all(
      tabs.map((tabId) => this.debuggers.release(s, tabId).catch((error) => this.log('detach a closed chat’s tab', error))),
    );
    const released = tabs.filter((tabId) => !this.owner.has(tabId));
    if (released.length) await this.chrome.tabs.ungroup(released).catch((error) => this.log('ungroup a closed chat’s tabs', error));
    this.#save();
  }

  /** @param {string} chat @param {unknown} turn the chat's new turn: commands of older turns are refused */
  advance(chat, turn) {
    const s = this.chats.get(chat);
    if (s && Number.isInteger(turn) && /** @type {number} */ (turn) > s.turn) s.turn = /** @type {number} */ (turn);
  }

  /** MoPilot went away: every debugger is let go; the groups and sessions stay for its return. */
  async peerGone() {
    const releases = [];
    // Retire every captured owner before awaiting cleanup: a reconnect may start while any tab is detaching.
    for (const s of [...this.chats.values()])
      for (const tabId of [...s.tabs]) releases.push(this.debuggers.release(s, tabId).catch((error) => this.log('let go of a tab', error)));
    await Promise.all(releases);
    this.#save();
  }

  /**
   * Runs one command for the chat.
   * @param {string} chat @param {string} method @param {any[]} params @param {number | undefined} turn
   * @param {unknown} [receipt] @param {boolean} [required]
   */
  async command(chat, method, params, turn, receipt, required = false) {
    const s = this.chats.get(chat);
    if (!s) throw new Error('This chat has no session in Chrome; MoPilot opens one first.');
    if (!RELEASES.has(method) && Number.isInteger(turn)) {
      if (/** @type {number} */ (turn) < s.turn) throw new Error('This browser step belongs to a turn that already ended.');
      s.turn = /** @type {number} */ (turn);
    }
    switch (method) {
      case 'session.adopt':
        return this.admissions.panel(chat, s, params[0]);
      case 'chrome.tabs.create':
        return this.#create(chat, s, params[0] ?? {});
      case 'chrome.tabs.remove': {
        const tabId = this.#mine(chat, params[0], receipt, required);
        const membership = this.#membership(tabId);
        await this.chrome.tabs.remove(tabId);
        if (this.#holds(chat, s, tabId) && this.memberships.get(tabId) === membership) this.#drop(chat, tabId);
        this.#save();
        return {};
      }
      case 'chrome.debugger.attach': {
        const tabId = this.#mine(chat, params[0]?.tabId, receipt, required);
        const membership = this.#membership(tabId);
        const startedTurn = s.turn;
        return this.debuggers.attach(
          s,
          tabId,
          String(params[1] || '1.3'),
          () => this.#holds(chat, s, tabId) && this.memberships.get(tabId) === membership && s.turn === startedTurn,
          membership,
        );
      }
      case 'chrome.debugger.detach': {
        const tabId = params[0]?.tabId;
        if (required) this.#mine(chat, tabId, receipt, true);
        // only this exact session's acknowledged or pending attachment, even if its tab has left
        return this.debuggers.release(s, tabId);
      }
      case 'chrome.debugger.sendCommand': {
        const target = params[0] ?? {};
        const tabId = this.#mine(chat, target.tabId, receipt, required);
        const debuggee = typeof target.sessionId === 'string' && target.sessionId ? { tabId, sessionId: target.sessionId } : { tabId };
        return this.debuggers.sendCommand(debuggee, String(params[1]), params[2] ?? {});
      }
      default:
        throw new Error(`${method} is not a command of MoPilot's extension.`);
    }
  }

  /** The tab id when it is one of the chat's tabs; throws otherwise. */
  #mine(chat, tabId, receipt, required = false) {
    if (!validTab(tabId) || this.owner.get(tabId) !== chat) throw new Error(`Chrome tab ${tabId} is not one of this chat's tabs.`);
    if (required && (!validReceipt(receipt) || this.#membership(tabId).id !== receipt))
      throw new Error('This Chrome tab membership no longer belongs to this operation.');
    return tabId;
  }

  async #create(chat, s, { url = 'about:blank' }) {
    if (!OPENABLE.test(String(url))) throw new Error('A new tab opens on about:blank or a web page only.');
    /** @type {number | undefined} */
    let windowId;
    if (s.groupId != null) {
      try {
        windowId = (await this.chrome.tabGroups.get(s.groupId)).windowId;
      } catch (error) {
        // Only a window hint: the grouping lane validates and replaces the canonical group.
        this.log('find the window for a chat’s group', error);
      }
    }
    if (this.chats.get(chat) !== s) throw new Error('This chat session closed while its Chrome tab was opening.');
    const tab = await this.openTab({ url, active: false, ...(windowId == null ? {} : { windowId }) });
    if (this.owner.has(tab.id)) throw new Error('This Chrome tab no longer belongs to this chat session.');
    if (this.chats.get(chat) !== s) {
      await this.chrome.tabs.remove(tab.id).catch((error) => this.log('close a tab opened for a retired chat', error));
      throw new Error('This chat session closed while its Chrome tab was opening.');
    }
    const current = this.#own(chat, s, tab.id);
    const groupId = await this.groups.put(s, tab.id, current);
    if (!current()) throw new Error('This Chrome tab no longer belongs to this chat session.');
    this.#membership(tab.id).groupId = /** @type {number} */ (groupId);
    this.#save();
    return { ...tab, groupId, ...(s.receipts ? { membership: this.#membership(tab.id).id } : {}) };
  }

  /** @param {string} chat @param {Session} s @param {number} tabId @param {any} [saved] @param {boolean} [restoring] */
  #own(chat, s, tabId, saved = null, restoring = false) {
    s.tabs.add(tabId);
    this.owner.set(tabId, chat);
    const restored = saved && !Array.isArray(saved) && validReceipt(saved.id);
    const membership = {
      // A restarted worker cannot know whether the final retirement snapshot reached storage.
      // Rotate even a valid saved receipt; only this live worker can preserve authority on reconnect.
      id: globalThis.crypto.randomUUID(),
      manual: Boolean(restored && saved.manual === true && validGroup(saved.groupId) && saved.groupId === s.groupId),
      groupId: restored && (validGroup(saved.groupId) || saved.groupId === -1) ? saved.groupId : restoring ? (s.groupId ?? -1) : null,
    };
    this.memberships.set(tabId, membership);
    return () => this.#holds(chat, s, tabId) && this.memberships.get(tabId) === membership;
  }

  /** One report carries exact membership; only a validated manual move supplies opener-free admission. */
  #report(chat, s, tab) {
    const membership = this.#membership(tab.id);
    this.send({
      chat,
      method: 'chrome.tabs.onCreated',
      params: [
        tab,
        ...(s.receipts
          ? [
              {
                membership: membership.id,
                ...(membership.manual ? { ownership: { kind: 'user_group', groupId: membership.groupId } } : {}),
              },
            ]
          : []),
      ],
    });
  }

  /** The tab leaves the chat (a tab a chat holds is always its own: the chat has a session). */
  #drop(chat, tabId) {
    const s = this.#session(chat);
    s.tabs.delete(tabId);
    this.debuggers.release(s, tabId).catch((error) => this.log('let go of a tab the user took back', error));
    this.owner.delete(tabId);
    this.memberships.delete(tabId);
    this.grouping.delete(tabId);
  }

  /** The membership of a tab whose exact owner was already checked. */
  #membership(tabId) {
    return /** @type {Membership} */ (this.memberships.get(tabId));
  }

  /** The session of a chat known to have one (it owns a tab). */
  #session(chat) {
    return /** @type {Session} */ (this.chats.get(chat));
  }

  /** A popup continuation belongs to this exact session and tab, never a closed or replaced chat. */
  #holds(chat, s, tabId) {
    return this.chats.get(chat) === s && this.owner.get(tabId) === chat;
  }

  /** The tab stops being the chat's (the user took it back): its debugger goes and MoPilot is told. */
  #release(chat, tabId, reason) {
    const s = this.#session(chat);
    const membership = this.#membership(tabId).id;
    this.#drop(chat, tabId);
    this.#save();
    this.send({ chat, method: 'chrome.debugger.onDetach', params: [{ tabId }, reason, ...(s.receipts ? [{ membership }] : [])] });
  }

  /* ---------- Chrome's events ---------- */

  onDebuggerEvent(source, method, params) {
    const tabId = source?.tabId;
    const chat = this.owner.get(tabId);
    if (!chat) return;
    const s = this.#session(chat);
    const membership = this.#membership(tabId);
    if (!this.debuggers.ownsEvents(s, tabId, membership)) return;
    this.send({
      chat,
      method: 'chrome.debugger.onEvent',
      params: [source, method, params ?? {}, ...(s.receipts ? [{ membership: membership.id }] : [])],
    });
  }

  onDebuggerDetach(source, reason) {
    const tabId = source?.tabId;
    if (reason === 'target_closed' && this.debuggers.recovering.has(tabId)) return; // a frame-clearing reload's (frameGuard.mjs)
    this.debuggers.forget(tabId);
    const chat = this.owner.get(tabId);
    if (!chat) return;
    const s = this.#session(chat);
    const membership = this.#membership(tabId).id;
    // the tab is closing: it stays the chat's until chrome.tabs.onRemoved, which MoPilot is told about too
    if (reason === 'target_closed') this.#session(chat).attached.delete(tabId);
    else this.#drop(chat, tabId);
    this.#save();
    // the user cancelled the debugging bar: the tab is theirs again, so it leaves the group
    if (reason === 'canceled_by_user')
      this.chrome.tabs.ungroup([tabId]).catch((error) => this.log('ungroup a tab the user took back', error));
    this.send({
      chat,
      method: 'chrome.debugger.onDetach',
      params: [{ tabId }, String(reason || ''), ...(s.receipts ? [{ membership }] : [])],
    });
  }

  async onTabCreated(tab) {
    if (!this.sourcedPopups) await this.admissions.popup(tab);
  }

  /**
   * A page opened a tab (a link with target=_blank, window.open): when the page is a chat's tab, the new tab is that
   * chat's, reported with the page's tab as its opener (main adopts a popup by its opener).
   * @param {{ sourceTabId?: number, tabId?: number }} details webNavigation.onCreatedNavigationTarget's
   */
  async onNavigationTarget(details) {
    const source = details?.sourceTabId;
    const tabId = details?.tabId;
    if (!this.owner.has(source) || !Number.isInteger(tabId) || this.owner.get(tabId) === this.owner.get(source)) return;
    let tab;
    try {
      tab = await this.chrome.tabs.get(tabId);
    } catch (error) {
      // closed before it could be read
      this.log('read a popup of a chat’s tab', error);
      return;
    }
    // Chrome may have put it in the group of the tab in front, another chat's, which took it as dragged in: it is the source's
    const chat = this.owner.get(source);
    const held = this.owner.get(tabId);
    // the source's chat closed meanwhile: the tab stays whose it is
    if (!chat) return;
    if (held && held !== chat) this.#release(held, tabId, 'removed_from_group');
    await this.admissions.popup({ ...tab, openerTabId: source });
  }

  onTabRemoved(tabId) {
    const chat = this.owner.get(tabId);
    if (!chat) return;
    const s = this.#session(chat);
    const membership = this.#membership(tabId).id;
    this.#drop(chat, tabId);
    this.#save();
    this.send({ chat, method: 'chrome.tabs.onRemoved', params: [tabId, ...(s.receipts ? [{ membership }] : [])] });
  }

  /** A tab changed group: dragged out of a chat's group it leaves the chat, dragged into one it joins it. */
  onTabUpdated(tabId, change, tab, reason = 'removed_from_group') {
    if (
      !change ||
      typeof change !== 'object' ||
      Array.isArray(change) ||
      !('groupId' in change) ||
      this.grouping.has(tabId) ||
      this.admissions.isMove(tabId, change.groupId)
    )
      return;
    if (
      !validTab(tabId) ||
      !Number.isSafeInteger(change.groupId) ||
      change.groupId < -1 ||
      tab?.id !== tabId ||
      tab.groupId !== change.groupId
    )
      return;
    const chat = this.owner.get(tabId);
    if (chat) {
      const s = this.#session(chat);
      if (change.groupId === (s.groupId ?? -1)) return;
      this.#release(chat, tabId, reason);
      if (this.owner.has(tabId)) return; // A reentrant observation already established newer ownership.
    }
    if (change.groupId === -1) return;
    for (const [other, s] of this.chats) {
      if (s.groupId !== change.groupId) continue;
      this.#own(other, s, tabId);
      const membership = this.#membership(tabId);
      membership.manual = true;
      membership.groupId = change.groupId;
      this.#save();
      this.#report(other, s, { ...tab, groupId: change.groupId });
      return;
    }
  }
}

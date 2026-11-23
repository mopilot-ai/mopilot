// The browser host for the user's Chrome over the Chrome relay (B2): the same BrowserTabs the browser_* tools run on, with Chrome tabs as its pages.
//
// The browser_* implementations (hostTools.cjs, and the host layers under them) are reused as they are:
// only the host's options differ from the in-app browser's.
// - spawn opens the chat's tab in Chrome: the connect page's own tab the first time (the extension
//   hands it to the connection), a new tab in the chat's group after that. Connecting happens on the
//   chat's first tab, so the first browser call is the one that waits for (or fails with) the extension.
// - close removes the tab in Chrome; open and select change nothing on screen (the user's Chrome window
//   is theirs: an agent tab is never brought to the front). So a chat's tab is usually hidden (a background tab,
//   or a collapsed group). Chrome draws a hidden tab no frames and drops or misroutes CDP input to it, so each
//   tab's CDP session emulates focus (Tab.attach, inputWhileHidden) and the host acts on it where it is.
// - A tab a chat's tab opens (window.open, a link with target=_blank) joins the chat's tabs as a tab of
//   its own, as a view tab's popup does in the pane.
// - The page lays out at the Chrome window's own size. The agent cursor draws with its control frame
//   (agentControlFrame.cjs): the page itself shows that the chat's agent works in it, with a Stop that stops the turn.
// - TargetLeases at the chat's end: the chat's tabs (and its tab group) are its own while it works in them. Once it
//   ran no turn for CHAT_IDLE_MS after its last turn end (as long as a Your Chrome instance waits), or when it is
//   archived or cleared, it lets go of them as a deleted chat does: the debuggers go, the tabs its agent opened close
//   unless kept (#closeLeftovers), and the rest leave the group and are the user's (the group disappears). A cleared chat whose turn still runs lets go at that turn's end. The
//   next browser call opens a new group. Within a turn and across turn ends the chat keeps its tabs (and a switch
//   hands them to the next harness).
// - When MoPilot's extension drops its connection (its service worker restarted) the chat's tabs stay the host's,
//   their debuggers let go: the next action on one reconnects, and the tab is the chat's again when the extension
//   reports it (it keeps the chat's session), or gone when it doesn't. A connection MoPilot closed, or the
//   Playwright Extension's (whose next connection reports none of them), takes its tabs with it.
// - Each turn end (the host's own) starts a new relay turn for the chat after the host let go, so a call
//   still running from that turn cannot reach Chrome; a chat that is forgotten drops its connection.
const { BrowserTabs } = require('./host.cjs');
const { ChromeTabContents } = require('./chromeTab.cjs');
const { CONNECT_PAGE, staleTurn } = require('./chromeRelay.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { addTab, tabOf } = require('./hostTabState.cjs');
const { reportChromeDownload } = require('./agentDownloads.cjs');
const crypto = require('node:crypto');

/** Whether the agent's reply names the tab: its address (without scheme, query or a trailing slash) or its title. */
function namedIn(/** @type {string} */ reply, /** @type {any} */ wc) {
  if (!reply) return false;
  const where = String(wc.url)
    .replace(/^https?:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
  const title = String(wc.title).trim();
  return (where.length > 3 && reply.includes(where)) || (title.length >= 6 && reply.includes(title));
}

/** How long a chat keeps its Chrome tabs after its last turn ended: as long as Your Chrome's instance waits (extension.cjs). */
const CHAT_IDLE_MS = 10 * 60_000;

/** The browser host over Chrome: forgetting a chat also drops its extension connection. */
class ChromeTabs extends BrowserTabs {
  /**
   * @param {ConstructorParameters<typeof BrowserTabs>[0]} o @param {InstanceType<typeof import('./chromeRelay.cjs').ChromeRelay>} relay
   * @param {{ idleMs?: number, busy?: (chatId: string) => boolean }} [lease]
   *   idleMs: how long a chat keeps its tabs after a turn end with no new turn; busy: whether the chat's turn runs now
   */
  constructor(o, relay, { idleMs = CHAT_IDLE_MS, busy = () => false } = {}) {
    super(o);
    this.relay = relay;
    this.idleMs = idleMs;
    this.busy = busy;
    /** chat id -> the timer that lets go of its tabs once it stayed idle */
    this.idle = new Map();
    /** chats let go of (cleared) while their turn ran: their tabs go at that turn's end */
    this.releasing = new Set();
    /** @type {Map<string, Map<number, string | null>>} explicit closes suppress replay, never authorize commands */
    this.closedTargets = new Map();
    /** chat id -> the agent's last reply: a tab it names stays open when the chat lets go (#1699) */
    this.replies = new Map();
    /** @type {WeakSet<object>} tabs the agent ever marked deliverable or handoff, or the user activated: never closed at let-go */
    this.kept = new WeakSet();
    /** stops following the relay */
    this.unhook = () => undefined;
  }

  /** The chat's turn ended: its tabs stay its own for idleMs (or go at once when it was let go meanwhile). */
  async turnEnded(chatId) {
    const out = await super.turnEnded(chatId);
    if (this.chats.has(chatId) || this.relay.link(chatId)) this.#idleFor(chatId, this.releasing.has(chatId) ? 0 : this.idleMs);
    // nothing of it to let go of: a release asked during this turn is done (it must not cut a later group short)
    else this.releasing.delete(chatId);
    return out;
  }

  /** Lets go of the chat's tabs after `ms`, unless a turn of it runs then (its end starts the wait again). */
  #idleFor(chatId, ms) {
    clearTimeout(this.idle.get(chatId));
    const timer = setTimeout(() => {
      this.idle.delete(chatId);
      if (this.busy(chatId)) return;
      this.forget(chatId);
    }, ms);
    timer.unref?.();
    this.idle.set(chatId, timer);
  }

  /** The chat ended (cleared): it lets go of its tabs now, or at the end of the turn it runs. */
  release(chatId) {
    if (this.busy(chatId)) this.releasing.add(chatId);
    else this.forget(chatId);
  }

  /**
   * Opens a tab for the chat in Chrome: the chat's connection first (the call fails with not_connected
   * when the extension doesn't connect), and the tab once Chrome opened it.
   * @param {string} chatId
   * @param {{ focus?: boolean }} [o]
   */
  async create(chatId, o) {
    const turn = this.relay.token(chatId).turn;
    await this.relay.connect(chatId);
    // the turn may have ended (Stop) while Chrome asked the user to approve the connection
    if (this.relay.token(chatId).turn !== turn) throw staleTurn();
    const tab = await super.create(chatId, o);
    await /** @type {InstanceType<typeof ChromeTabContents>} */ (tab.backend).created;
    return tab;
  }

  /**
   * The chat's Chrome tabs as TargetLeases, by Chrome's own tab id (what the chrome_* tools and the Codex backend take):
   * a switch's handoff names them, and the chat keeps them on the next harness.
   * @returns {import('../targetLeases.cjs').Lease[]}
   */
  leases(chatId) {
    const list = this.list(chatId);
    return super.leases(chatId).map((l, i) => ({ ...l, surface: 'chromeTab', id: String(list[i].backend.tabId ?? l.id) }));
  }

  /**
   * Every tab of a chat goes (the chat was deleted, archived, cleared or stayed idle), and its connection with them:
   * the tabs its agent opened and nobody keeps close (closeLeftovers); the extension lets go of the rest and ungroups
   * them, the user's again.
   */
  forget(chatId) {
    clearTimeout(this.idle.get(chatId));
    this.idle.delete(chatId);
    this.releasing.delete(chatId);
    this.#closeLeftovers(chatId);
    this.closedTargets.delete(chatId);
    super.forget(chatId);
    this.relay.disconnect(chatId);
  }

  /**
   * At the chat's let-go (#1699: finished chats' tabs piled up in the user's Chrome), the tabs its agent opened close,
   * except one the user activated or took over, one ever marked deliverable or handoff, and one the agent's last reply
   * names (its address or title): those, and tabs the user brought into the group, stay the user's.
   */
  #closeLeftovers(chatId) {
    const reply = this.replies.get(chatId) ?? '';
    this.replies.delete(chatId);
    for (const t of this.list(chatId)) {
      if (!t.openedByAgent || t.userTook || this.kept.has(t) || this.kept.has(t.backend) || namedIn(reply, t.backend)) continue;
      try {
        this.o.close(t);
      } catch (error) {
        // the tab may already be closing; the extension ungroups what is left
        noteIgnored("close a let-go chat's tab in Chrome", error);
      }
    }
  }

  /** The agent's reply at its turn's end (ChatController onFinished): a tab it names stays when the chat lets go. */
  noteReply(/** @type {string} */ chatId, /** @type {unknown} */ text) {
    if (typeof text === 'string' && text) this.replies.set(chatId, text.slice(-20_000));
  }

  /** A mark keeps the tab open past the chat's let-go too, after the mark itself lapsed (BrowserTabs mark). */
  mark(/** @type {string} */ chatId, /** @type {string} */ tabId, /** @type {string} */ status) {
    const t = super.mark(chatId, tabId, status);
    this.kept.add(t);
    return t;
  }

  /** Stops following the relay (the switch went off). */
  dispose() {
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.closedTargets.clear();
    this.unhook();
  }
}

/**
 * The browser host whose tabs are the chats' Chrome tabs.
 * @param {{ relay: InstanceType<typeof import('./chromeRelay.cjs').ChromeRelay>,
 *           images: { fromBuffer: (buf: Buffer) => any },
 *           modelOf?: (chatId: string) => string | null | Promise<string | null>,
 *           onChange?: (chatId: string) => void, idleMs?: number, busy?: (chatId: string) => boolean,
 *           cursor?: InstanceType<typeof import('./agentCursor.cjs').AgentCursor> }} o
 *   idleMs, busy: when a chat that ran no turn for a while lets go of its tabs (ChromeTabs); cursor: the agent cursor
 *   with its control frame, drawn on the chat's tabs
 */
function chromeBrowserTabs({ relay, images, modelOf, onChange, idleMs, busy, cursor }) {
  /** Chrome tab id -> its contents, per chat */
  const byChat = new Map();
  /** @type {Map<string, Map<number, string | null>>} Chrome tab ids per chat, closed while its connection was down: they close once it is back */
  const closeOnResume = new Map();
  const contentsOf = (chatId) => {
    let m = byChat.get(chatId);
    if (!m) byChat.set(chatId, (m = new Map()));
    return m;
  };
  const track = (chatId, wc) => {
    wc.created.then(
      () => {
        if (!wc.isDestroyed()) contentsOf(chatId).set(wc.tabId, wc);
      },
      () => undefined,
    );
    wc.once('destroyed', () => {
      const m = byChat.get(chatId);
      if (m && m.get(wc.tabId) === wc) m.delete(wc.tabId);
    });
    return wc;
  };

  /**
   * The chat's first tab is the connect page's (create connected first); later ones are new tabs, opened
   * under the turn token taken when the host asked for the tab.
   */
  const openTab = async (chatId, tok) => {
    const link = await relay.connect(chatId);
    const reuse = link.connectTab;
    if (reuse != null && link.tabs.has(reuse)) {
      link.connectTab = null;
      return link.tabs.get(reuse);
    }
    return relay.createTab(tok, 'about:blank');
  };

  const tabs = new ChromeTabs(
    {
      // no MoPilot window or partition is a Chrome tab: assertCdpTarget lets relay tabs through on their own check
      appContents: () => [],
      panelSession: () => null,
      spawn: (chatId) => track(chatId, new ChromeTabContents({ relay, chatId, open: openTab(chatId, relay.token(chatId)) })),
      open: () => true,
      close: (tab) => {
        const wc = /** @type {InstanceType<typeof ChromeTabContents>} */ (tab.backend);
        const suppress = () => {
          if (wc.tabId == null) return;
          let targets = tabs.closedTargets.get(tab.chatId);
          if (!targets) tabs.closedTargets.set(tab.chatId, (targets = new Map()));
          targets.set(wc.tabId, wc.membership);
        };
        suppress();
        const remove = () =>
          relay.removeTab(wc.token(), /** @type {number} */ (wc.tabId)).then(
            () => {
              confirmClosed(tab.chatId, wc.tabId, wc.membership);
              wc.gone();
            },
            (error) => noteIgnored('close a Chrome tab over the relay', error),
          );
        if (wc.resuming) {
          // kept from a connection that dropped: it goes now, and Chrome's tab once the chat's connection is back
          let later = closeOnResume.get(tab.chatId);
          if (!later) closeOnResume.set(tab.chatId, (later = new Map()));
          later.set(/** @type {number} */ (wc.tabId), wc.membership);
          wc.gone();
          return;
        }
        if (wc.tabId != null) return void remove();
        // still opening: it goes now, and Chrome's tab once it exists, so none is left without an owner
        wc.gone();
        wc.created.then(
          () => {
            suppress();
            return remove();
          },
          () => undefined,
        );
      },
      select: () => undefined,
      images,
      modelOf,
      onChange,
      inputWhileHidden: true,
      keepTabsOnTurnEnd: true,
      ...(cursor ? { cursor } : {}),
    },
    relay,
    { idleMs, busy },
  );

  const confirmClosed = (chatId, tabId, membership) => {
    const targets = tabs.closedTargets.get(chatId);
    if (targets && targets.get(tabId) === membership) targets.delete(tabId);
  };
  let disposed = false;
  const links = new Map();
  const current = (chatId, link) => !disposed && links.get(chatId) === link;
  /** Replay and live reports share one drain: an explicit opener chain must reach this chat's live tab. */
  const adoptReported = (chatId, link, replayed = new Map()) => {
    let added;
    do {
      added = false;
      for (const tab of link.tabs.values()) {
        if (tabs.closedTargets.get(chatId)?.has(tab.id)) continue;
        if (!current(chatId, link) || relay.link(chatId) !== link) return;
        const reported = () => current(chatId, link) && relay.link(chatId) === link && link.tabs.get(tab.id) === tab;
        const known = byChat.get(chatId)?.get(tab.id);
        if (known && known.membership !== (tab.membership ?? null)) known.gone();
        if (!reported()) return;
        const manual = link.membershipReceipts && link.memberships.get(tab.id)?.manual;
        const rehydrated = replayed.get(tab.id) === tab;
        const opener = Number.isInteger(tab.openerTabId) ? byChat.get(chatId)?.get(tab.openerTabId) : null;
        if (
          (!manual && !rehydrated && (!opener || opener.isDestroyed() || opener.resuming)) ||
          byChat.get(chatId)?.has(tab.id) ||
          String(tab.url || '').startsWith(CONNECT_PAGE)
        )
          continue;
        // Only the current authenticated manual proof can displace a suspended source wrapper on replay.
        if (manual) for (const [other, contents] of byChat) if (other !== chatId) contents.get(tab.id)?.gone();
        if (!reported()) return;
        const wc = track(chatId, new ChromeTabContents({ relay, chatId, tab }));
        contentsOf(chatId).set(tab.id, wc);
        const adopted =
          manual || rehydrated
            ? addTab(tabs, chatId, { id: `tab_${crypto.randomBytes(3).toString('hex')}`, wc, owner: null, created: false })
            : tabs.adoptPopup(opener, wc, { asTab: true });
        if (!adopted) {
          wc.gone();
          continue;
        }
        if (!wc.isDestroyed()) added = true;
        tabs.emit(chatId);
      }
    } while (added);
  };

  const wire = (chatId, link) => {
    link.on('cdp', (source, method, params) => {
      if (current(chatId, link)) byChat.get(chatId)?.get(source.tabId)?.event(source, method, params);
    });
    link.on('detach', (tabId, reason) => {
      if (!current(chatId, link)) return;
      const wc = byChat.get(chatId)?.get(tabId);
      // as the link decides (chromeLink.cjs): target_closed loses only the debugger, any other reason the tab
      if (reason === 'target_closed') wc?.debugger.lost(reason);
      else wc?.gone(reason);
    });
    link.on('removed', (tabId) => {
      if (current(chatId, link)) {
        tabs.closedTargets.get(chatId)?.delete(tabId);
        byChat.get(chatId)?.get(tabId)?.gone('closed');
      }
    });
    // the user brought one of the chat's tabs to the front: theirs to keep when the chat lets go (#1699)
    link.on('activated', (tabId) => {
      const wc = current(chatId, link) ? byChat.get(chatId)?.get(tabId) : null;
      if (wc) tabs.kept.add(wc);
    });
    link.on('tab', (tab) => {
      const suppressed = tabs.closedTargets.get(chatId);
      // Initial/duplicate replay cannot undo an explicit close. Only a later live manual transition can.
      if (
        current(chatId, link) &&
        relay.link(chatId) === link &&
        link.membershipReceipts &&
        suppressed?.has(tab.id) &&
        suppressed.get(tab.id) !== tab.membership &&
        link.memberships.get(tab.id)?.manual
      )
        suppressed.delete(tab.id);
      adoptReported(chatId, link);
    });
    // a download the chat's agent started in its tab: reported with the chat's next result, as the in-app browser's
    link.on('download', (d) => {
      const wc = current(chatId, link) ? byChat.get(chatId)?.get(d.tabId) : null;
      const tab = wc && tabOf(tabs, wc);
      if (tab) reportChromeDownload(tabs, tab, d);
    });
    link.once('closed', () => {
      if (!current(chatId, link)) return;
      links.delete(chatId);
      const kept = link.resumable;
      // a connection that only dropped (the extension's service worker restarted) keeps the chat's tabs for the next one
      for (const wc of [...(byChat.get(chatId)?.values() ?? [])]) {
        if (kept) wc.suspend();
        else wc.gone();
      }
      if (!kept) byChat.delete(chatId);
    });
  };
  const onConnected = (chatId, link) => {
    links.set(chatId, link);
    wire(chatId, link);
    const suppressed = tabs.closedTargets.get(chatId);
    if (suppressed) for (const [tabId, membership] of suppressed) suppressed.set(tabId, link.tabs.get(tabId)?.membership ?? membership);
    // the chat's tabs kept from a dropped connection are its own again when the extension reported them; one it no
    // longer has (closed, or taken back, while it was away) is gone
    const replayed = new Map();
    for (const wc of [...(byChat.get(chatId)?.values() ?? [])]) {
      if (!wc.resuming) continue;
      if (suppressed?.has(wc.tabId)) {
        wc.gone();
        continue;
      }
      const tab = link.tabs.get(wc.tabId);
      // Worker restore rotates receipts. Only an extant, previously negotiated wrapper anchors rehydration;
      // closed-offline cleanup records and legacy/unknown ids never do. All transient tab state starts fresh.
      if (
        link.membershipReceipts &&
        wc.membership !== null &&
        tab?.membership !== wc.membership &&
        relay.owns(chatId, wc.tabId, tab?.membership)
      )
        replayed.set(wc.tabId, tab);
      wc.resumed(tab);
    }
    adoptReported(chatId, link, replayed);
    // tabs the chat closed while the connection was down close in Chrome now
    const later = closeOnResume.get(chatId) ?? new Map();
    closeOnResume.delete(chatId);
    for (const [tabId, membership] of later)
      if (relay.owns(chatId, tabId, membership))
        relay
          .removeTab({ ...relay.token(chatId), membership }, tabId)
          .then(() => confirmClosed(chatId, tabId, membership))
          .catch((error) => noteIgnored('close a Chrome tab after reconnecting', error));
  };
  relay.on('connected', onConnected);

  const offTurn = tabs.onTurnEnd((chatId) => relay.advance(chatId));
  tabs.unhook = () => {
    disposed = true;
    links.clear();
    relay.off('connected', onConnected);
    offTurn();
  };
  return tabs;
}

module.exports = { chromeBrowserTabs, ChromeTabs, CHAT_IDLE_MS };

// The browser host's tabs per chat: attaching, opening, selecting, closing and marking them, take-over and sign-in hand-offs, the turn end, downloads, the status every result carries, and one action at a time per tab.
const { noteIgnored } = require('../../ignored.cjs');
const { HostEvents } = require('./hostEvents.cjs');
const crypto = require('node:crypto');
const { ToolError } = require('../contract/registry.cjs');
const { liveness, stopped } = require('../contract/actionGuard.cjs');
const { assertCdpTarget } = require('./cdp.cjs');
const { originOf, siteOf } = require('./origins.cjs');
const { leaseOutcome } = require('../targetLeases.cjs');
const {
  MAX_TABS,
  ACTION_MS,
  CLOSE_MS,
  TURN_END_MS,
  LAYERS,
  MARKS,
  withTimeout,
  runAction,
  waitingForUser,
  waitEvent,
  oneLine,
} = require('./hostUtil.cjs');
const { saveAgentDownload, isDownloadOutcome } = require('./agentDownloads.cjs');
const { unresponsiveNote } = require('../../../shared/browserNotice.mjs');
const { chatState, used, reveal, tabOf, addTab, tabGone, setSelected, missingTab, letGo } = require('./hostTabState.cjs');
const { samePage, setLayer } = require('./hostTabState.cjs');
const { isViewTab } = require('./views.cjs');
const { handOver, endHandoff, endHandoffs, handoffDone, handoffMoved, heldError } = require('./userTurn.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs the host these methods and helpers run on */
/** @typedef {import('./host.cjs').Tab} Tab */
/** @typedef {import('./host.cjs').PagePoint} PagePoint */

class HostTabs extends HostEvents {
  /**
   * The chat's tab a pane tab names: its browser_* id, or null for the chat's original tab.
   * @this {BrowserTabs}
   */
  byKey(chatId, tabKey) {
    const c = this.chats.get(chatId);
    if (!c) return null;
    const t = typeof tabKey === 'string' && tabKey ? c.tabs.get(tabKey) : [...c.tabs.values()].find((x) => x.legacy);
    return t && !t.closed && !t.backend.isDestroyed() ? t : null;
  }

  /**
   * "Take over" (on) in the pane: the agent's calls on the tab fail with a note for the rest of the
   * turn, and the next result tells it. "Hand back" (off) lets it continue. False for no such tab.
   * @this {BrowserTabs}
   */
  takeOver(chatId, tabKey, on = true) {
    const t = this.byKey(chatId, tabKey);
    if (!t) return false;
    if (t.takenOver === !!on) return true;
    t.takenOver = !!on;
    t.userTook = !!on;
    if (on) {
      this.o.cursor?.clear(t);
    }
    this.change(
      chatId,
      on
        ? `user_took_over ${t.id}: the user is using this tab now; don't act on it again this turn`
        : `user_handed_back ${t.id}: you may act on it again`,
    );
    this.emit(chatId);
    return true;
  }

  /**
   * A window reports how its pane lays out a page (IPC browser:layer): 'front', 'back' (painted behind
   * the pane) or 'none'. Only a panel guest of that window counts; false otherwise.
   * @this {BrowserTabs}
   */
  layer(wc, layer, owner) {
    if (!LAYERS.has(layer)) return false;
    try {
      assertCdpTarget(wc, { appContents: this.o.appContents(), panelSession: this.o.panelSession(), host: owner });
    } catch {
      return false;
    }
    setLayer(this, wc, layer);
    return true;
  }

  /**
   * The user hid the browser pane while the chat's agent was using it: no more automatic reveals this turn.
   * @this {BrowserTabs}
   */
  paneHidden(chatId) {
    const c = this.chats.get(chatId);
    if (c) c.revealOff = true;
  }

  /**
   * A state change to report with the chat's next result (tab opened, alert accepted, download...).
   * @this {BrowserTabs}
   */
  change(chatId, text) {
    const c = chatState(this, chatId);
    c.changes.push(text);
    if (c.changes.length > 50) c.changes.shift();
  }

  /**
   * A window reports a panel tab for an agent's chat (IPC browser:attach). `tabKey` is null for the
   * chat's original tab, which predates per-chat tab ids. Throws (keeping nothing) for a bad target.
   * @this {BrowserTabs}
   */
  attach(chatId, tabKey, wc, owner) {
    if (typeof chatId !== 'string' || !chatId) throw new ToolError('no chat', 'bad_target');
    assertCdpTarget(wc, { appContents: this.o.appContents(), panelSession: this.o.panelSession(), host: owner });
    const c = chatState(this, chatId);
    const key = typeof tabKey === 'string' && /^tab_[0-9a-f]{6,16}$/.test(tabKey) ? tabKey : null;
    let tab = key ? c.tabs.get(key) : [...c.tabs.values()].find((t) => t.legacy);
    /** @type {Tab | null} */
    let carry = null;
    if (tab && !samePage(tab, wc)) {
      // the pane remounted this tab's page
      carry = tab;
      tab.detach();
      c.tabs.delete(tab.id);
      tab.closed = true;
      tab = null;
    } else if (!tab) {
      // the page of a tab whose old page already went (the pane was hidden and shown again)
      carry = c.orphans.get(key ?? '') ?? null;
    }
    c.orphans.delete(key ?? '');
    if (!tab) {
      tab = addTab(this, chatId, {
        id: carry?.id || key || `tab_${crypto.randomBytes(3).toString('hex')}`,
        wc,
        owner,
        legacy: !key,
        created: !!carry?.created,
      });
      tab.mark = carry?.mark ?? null;
      tab.takenOver = !!carry?.takenOver;
      tab.openedByAgent = !!carry?.openedByAgent;
      tab.userTook = !!carry?.userTook;
      tab.used = carry?.used ?? 0;
      tab.result = !!carry?.result;
    } else if (c.selected === tab.id) setSelected(this, c, tab);
    const waitKey = `${chatId} ${tab.legacy ? '' : tab.id}`;
    for (const r of this.waiting.get(waitKey) || []) r();
    this.waiting.delete(waitKey);
    return tab;
  }

  /**
   * A popup opened from a chat's tab (window.open, OAuth) joins that chat's tabs: a native popup
   * window, or with `asTab` (a view tab's popup, views.cjs) a pane tab of its own.
   * @this {BrowserTabs}
   */
  adoptPopup(opener, wc, { asTab = false } = {}) {
    const parent = tabOf(this, opener);
    if (!parent || tabOf(this, wc)) return null;
    const root = parent.kind === 'popup' ? parent.root : parent;
    const tab = addTab(this, parent.chatId, {
      id: `tab_${crypto.randomBytes(3).toString('hex')}`,
      wc,
      owner: parent.owner,
      ...(asTab ? {} : { kind: 'popup', root }),
      created: parent.created,
    });
    setSelected(this, chatState(this, parent.chatId), tab);
    this.change(parent.chatId, `tab_opened ${tab.id} (popup from ${parent.id}; it is now the current tab)`);
    return tab;
  }

  /** @this {BrowserTabs} */
  list(chatId) {
    const c = this.chats.get(chatId);
    return c ? [...c.tabs.values()].filter((t) => !t.closed && !t.backend.isDestroyed()) : [];
  }

  /** @this {BrowserTabs} */
  current(chatId) {
    const c = this.chats.get(chatId);
    const t = c && c.selected && c.tabs.get(c.selected);
    return t && !t.closed && !t.backend.isDestroyed() ? t : null;
  }

  /**
   * The tab a call names, which must be this chat's; without a name, the current tab (one is opened if none).
   * @this {BrowserTabs}
   */
  async resolve(chatId, tabId) {
    if (tabId != null && tabId !== '') {
      const t = this.chats.get(chatId)?.tabs.get(String(tabId));
      if (!t || t.closed || t.backend.isDestroyed()) throw missingTab(this, chatId, tabId);
      return t;
    }
    return this.current(chatId) || this.create(chatId, { focus: true });
  }

  /**
   * Opens a tab for the chat in the browser pane: a view main owns (o.spawn), which works with no
   * window open and is shown in a window's pane when there is one, or with views off a pane <webview>
   * a window opens, resolving when its page attaches. `history`: a duplicate's, the view's first; `after`: its source's key.
   * @this {BrowserTabs}
   */
  async create(chatId, { focus = false, history = null, after = undefined } = {}) {
    if (this.list(chatId).length >= MAX_TABS)
      throw new ToolError(`This chat already has ${MAX_TABS} tabs. Close one with browser_tabs_close first.`, 'limit');
    const tabKey = `tab_${crypto.randomBytes(3).toString('hex')}`;
    const owner = this.current(chatId)?.owner || null;
    const spawned = this.o.spawn?.(chatId, history) ?? null;
    if (spawned) {
      const tab = this.attach(chatId, tabKey, spawned, null);
      tab.created = tab.openedByAgent = true;
      setSelected(this, chatState(this, chatId), tab);
      this.change(chatId, `tab_opened ${tab.id}`);
      this.emit(chatId);
      try {
        this.o.open(chatId, { tabKey, focus, owner, ...(after === undefined ? {} : { after }) });
      } catch (error) {
        // showing the tab in a window is cosmetic: it works without one
        noteIgnored('show a new agent tab in a window', error);
      }
      return tab;
    }
    const waitKey = `${chatId} ${tabKey}`;
    const arrived = new Promise((resolve) => {
      const list = this.waiting.get(waitKey) || [];
      list.push(resolve);
      this.waiting.set(waitKey, list);
      setTimeout(resolve, this.attachMs).unref?.();
    });
    if (this.o.open(chatId, { tabKey, focus, owner, ...(after === undefined ? {} : { after }) }) === false) {
      this.waiting.delete(waitKey);
      throw new ToolError('There is no MoPilot window to open the browser in.', 'no_browser');
    }
    await arrived;
    this.waiting.delete(waitKey);
    const tab = this.chats.get(chatId)?.tabs.get(tabKey);
    if (!tab || tab.closed)
      throw new ToolError("The browser tab didn't open in MoPilot. Make sure a MoPilot window is open.", 'no_browser');
    tab.created = tab.openedByAgent = true;
    used(this, tab);
    setSelected(this, chatState(this, chatId), tab);
    this.change(chatId, `tab_opened ${tab.id}`);
    this.emit(chatId);
    return tab;
  }

  /**
   * Closes a tab (its pane tab, or a popup's window) and waits briefly for it to go.
   * @this {BrowserTabs}
   */
  async close(chatId, tabId) {
    const tab = await this.resolve(chatId, tabId);
    const gone = tab.backend.isDestroyed() ? Promise.resolve() : waitEvent(tab.backend, ['destroyed'], CLOSE_MS);
    tab.closing = true;
    try {
      this.o.close(tab);
    } catch (error) {
      // the tab may already be closing; the wait below is bounded
      noteIgnored('close a browser tab', error);
    }
    await gone;
    tabGone(this, tab);
    return tab;
  }

  /**
   * An action an agent took on the tab outside the browser_* tools (the Codex Browser plugin's backend): the
   * turn's result tab is the one acted on last, whoever acted.
   * @this {BrowserTabs}
   */
  acted(tab) {
    used(this, tab);
  }

  /** @this {BrowserTabs} */
  select(chatId, tabId) {
    const t = this.chats.get(chatId)?.tabs.get(String(tabId));
    if (!t || t.closed || t.backend.isDestroyed()) throw new ToolError(`No tab ${oneLine(tabId, 80)} in this chat.`, 'bad_args');
    setSelected(this, chatState(this, chatId), t);
    try {
      this.o.select(t, { auto: true });
    } catch (error) {
      // the tab is selected for the agent; showing it in the pane is cosmetic
      noteIgnored('show the selected tab in the pane', error);
    }
    return t;
  }

  /**
   * The chat's tabs as TargetLeases: whether each is the agent's this turn (`origin`, what the turn end decides by)
   * or who opened it in any turn (`openedBy`), its mark, whether the user has it, whether the agent controls it now,
   * and its site (never the path or query, which may carry a token).
   * @this {BrowserTabs}
   * @returns {import('../targetLeases.cjs').Lease[]}
   */
  leases(chatId) {
    return this.list(chatId).map((t) => ({
      surface: 'iab',
      id: t.id,
      origin: t.created ? 'agent' : 'user',
      openedBy: t.openedByAgent ? 'agent' : 'user',
      mark: t.mark,
      takenOver: t.takenOver,
      userTook: t.userTook,
      held: t.held,
      site: originOf(t.url),
      popup: t.kind === 'popup',
    }));
  }

  /** @this {BrowserTabs} */
  mark(chatId, tabId, status) {
    if (!MARKS.has(status)) throw new ToolError('status must be "deliverable" or "handoff".', 'bad_args');
    const t = this.chats.get(chatId)?.tabs.get(String(tabId));
    if (!t || t.closed) throw new ToolError(`No tab ${oneLine(tabId, 80)} in this chat.`, 'bad_args');
    t.mark = status;
    // the mark is this turn's: it decides what the turn end does with the tab, and lapses at the next turn's end
    t.markTurn = this.turnsEnded.get(chatId) ?? 0;
    this.emit(chatId);
    return t;
  }

  /**
   * The chat's turn ended (any harness). Idempotent and bounded by TURN_END_MS: first the agent cursor and held keys go
   * while the turn's CDP commands still reach the page (a relay tab refuses them after); then it closes the tabs the agent
   * opened this turn and did not mark deliverable/handoff, except the one it acted on last (the turn's `result`, with the popup
   * it acted in last: a support chat a turn's question must not end), releases the chat's pending waits and detaches CDP
   * from the tabs that stay (they keep their page). Hosts with chat-lifetime tabs keep every tab and only release its per-turn control.
   * @this {BrowserTabs}
   */
  async turnEnded(chatId) {
    const outcomeOf = (/** @type {Tab} */ t) =>
      this.o.keepTabsOnTurnEnd ? 'release' : leaseOutcome({ origin: t.created ? 'agent' : 'user', mark: t.mark, takenOver: t.takenOver });
    const ended = this.turnsEnded.get(chatId) ?? 0;
    await letGo(this.o.cursor, this.chats.get(chatId)?.tabs.values() ?? [], ended);
    turnOver(this, chatId);
    this.turnsEnded.set(chatId, ended + 1);
    const c = this.chats.get(chatId);
    for (const [key, list] of [...this.waiting]) {
      if (!key.startsWith(`${chatId} `)) continue;
      this.waiting.delete(key);
      for (const r of list) r();
    }
    if (!c) return { closed: [], kept: [] };
    const [closing, kept] = [/** @type {Tab[]} */ ([]), /** @type {string[]} */ ([])];
    const live = [...c.tabs.values()].filter((t) => !t.closed);
    // last turn's result is an ordinary tab now; this turn's is the agent-opened tab it acted on last
    for (const t of live) t.result = false;
    // a mark given in an earlier turn has done its job (the tab stayed, the user had their turn): it lapses
    // (one the user still holds stays: the tab is theirs until their turn ends)
    for (const t of live) if (t.mark && t.markTurn < ended && !t.signin) t.mark = null;
    const result = live
      .filter((t) => t.kind === 'tab' && outcomeOf(t) === 'close')
      .reduce((a, t) => (a && a.used >= t.used ? a : t), /** @type {Tab | null} */ (null));
    if (result) result.result = true;
    const finishedIn = result && live.find((t) => t.kind === 'popup' && t.root === result && t.used === result.used);
    for (const t of live) {
      for (const w of t.dialogWaiters) w(null);
      t.dialogWaiters.clear();
      // a tab the user took over is theirs now: it stays open
      if (outcomeOf(t) === 'close' && !t.result && t !== finishedIn) closing.push(t);
      else {
        t.created = false;
        t.takenOver = false;
        t.detach();
        kept.push(t.id);
      }
    }
    const closed = closing.map((t) => t.id);
    // tabs whose page is gone while the pane is hidden: close the agent's (the pane drops them), keep the rest
    for (const [key, t] of [...c.orphans]) {
      if (outcomeOf(t) === 'close') {
        c.orphans.delete(key);
        closed.push(t.id);
        try {
          this.o.close(t);
        } catch (error) {
          // the tab may already be closing
          noteIgnored('close an orphaned agent tab at turn end', error);
        }
      } else {
        t.created = false;
        t.takenOver = false;
      }
    }
    await withTimeout(
      Promise.all(
        closing.map((t) =>
          this.close(chatId, t.id).catch((error) => {
            // a tab that fails to close is detached below
            noteIgnored("close a chat's agent tab", error);
          }),
        ),
      ),
      TURN_END_MS,
      () => {
        /* timed out: the tabs left open are detached below */
      },
    );
    for (const t of closing) if (!t.closed) t.detach();
    // the result comes to the front of its pane, unless the user hid the pane this turn
    if (result && !c.revealOff) {
      try {
        this.o.select(result, { auto: true });
      } catch (error) {
        // showing the result is cosmetic
        noteIgnored('show the resulting tab in the pane', error);
      }
    }
    // this turn's changes are done with, but not where a download landed: the agent hears that with its next result
    c.changes = c.changes.filter(isDownloadOutcome);
    c.revealed = null;
    c.revealOff = false;
    this.emit(chatId);
    return { closed, kept };
  }

  /**
   * Every tab of a chat goes (the chat was deleted).
   * @this {BrowserTabs}
   */
  forget(chatId) {
    turnOver(this, chatId);
    this.turnsEnded.delete(chatId);
    const c = this.chats.get(chatId);
    if (!c) return;
    for (const t of c.tabs.values()) {
      endHandoff(this, t, 'stopped');
      t.detach();
      // main owns a view tab's page: it goes with its chat (a pane's <webview> goes with the pane)
      if (isViewTab(t.backend))
        try {
          t.closing = true;
          this.o.close(t);
        } catch (error) {
          // the page may already be closing
          noteIgnored('close the tab of a deleted chat', error);
        }
    }
    this.chats.delete(chatId);
  }

  /**
   * A download started in the panel session. When an agent holds the tab, it is saved into the chat's
   * downloads folder and reported (agentDownloads.cjs). Returns the path, or null to leave it to the
   * user's download settings.
   * @this {BrowserTabs}
   */
  download(item, wc) {
    const tab = wc && tabOf(this, wc);
    // only while the agent drives the tab: a file the user downloads after Take over, or during a sign-in hand-off
    // (recovery codes, say), is theirs, saved by their own download settings and never reported to the agent
    if (!tab || !this.driver(wc)?.agent || !this.o.downloadsDir) return null;
    return saveAgentDownload(this, tab, item, this.o.downloadsDir(tab.chatId));
  }

  /** Hands a tab to the user (browser_request_signin, userTurn.cjs): returns at once, and the hold outlives the turn. @this {BrowserTabs} */
  requestSignin(tab, /** @type {{ reason?: string, credential?: boolean }} */ o = {}) {
    handOver(this, tab, o);
  }

  /** "Done, continue" (done) or giving up on a chat's held tab (userTurn.cjs handoffDone). @this {BrowserTabs} */
  signinDone(chatId, tabId, done = true) {
    return handoffDone(this, chatId, tabId, done);
  }

  /** The user took a chat's hand-off to their Chrome (userTurn.cjs handoffMoved). @this {BrowserTabs} */
  signinMoved(chatId, note, /** @type {number | null | undefined} */ wcId = null) {
    return handoffMoved(this, chatId, note, wcId);
  }

  /** Ends every hand-off of a chat: the user replied, pressed Stop or switched harness (userTurn.cjs). @this {BrowserTabs} */
  endHandoffs(chatId, /** @type {import('./userTurn.cjs').HandoffEnd} */ how) {
    return endHandoffs(this, chatId, how);
  }

  /**
   * The short status every result carries; the current tab's address once, shortened (G10: a long URL was in each result 3 times).
   * @this {BrowserTabs}
   */
  state(chatId) {
    const tabs = this.list(chatId);
    const cur = this.current(chatId);
    const c = this.chats.get(chatId);
    const lines = ['<browser_state>'];
    if (cur) lines.push(`current tab: ${cur.id} · ${oneLine(cur.title, 120) || '(untitled)'} · ${oneLine(cur.url, 160) || 'about:blank'}`);
    lines.push(
      tabs.length
        ? `tabs: ${tabs.map((t) => `${t.id}${t === cur ? '*' : ''}${t.kind === 'popup' ? ' (popup)' : ''}${t.mark ? ` [${t.mark}]` : ''}${t === cur ? '' : ` ${oneLine(t.url, 120) || 'about:blank'}`}`).join(' | ')}`
        : 'tabs: none',
    );
    for (const t of tabs) {
      if (this.o.hang?.hung(t.backend)) lines.push(`not responding: ${unresponsiveNote(t.id)}`);
      if (t.dialog)
        lines.push(
          `dialog open in ${t.id}${t.dialog.frame ? ` (from an embedded page at ${oneLine(t.dialog.frame, 120)})` : ''}: ${t.dialog.type} "${oneLine(t.dialog.message, 300)}"${t.dialog.type === 'prompt' ? ` (default answer "${oneLine(t.dialog.defaultPrompt, 120)}")` : ''} — answer it with browser_handle_dialog${t.dialog.type === 'prompt' ? ' (promptText is the answer)' : ''}`,
        );
      if (t.fileChooser)
        lines.push(`file chooser open in ${t.id} — use browser_file_upload, or browser_handle_dialog with accept=false to cancel`);
      const active = t.downloads.filter((d) => d.state === 'progressing');
      if (active.length) lines.push(`downloading in ${t.id}: ${active.map((d) => d.name).join(', ')}`);
    }
    if (c?.changes.length) {
      lines.push(`changes: ${c.changes.join('; ')}`);
      c.changes = [];
    }
    lines.push('</browser_state>');
    return lines.join('\n');
  }

  /**
   * Waits for the user's answer `p` (a site, action or JavaScript card) for an action on `tab`: inside run() the
   * action's clock stops meanwhile (the tab's queue holds, so the action still runs on the page it asked about;
   * a card ends with the turn). The user may have used the tab while the card was open, so it is checked again:
   * still open and this agent's to drive, and on the site the card named. `signal`: the call that asked; when it
   * ends (a stopped turn, a script out of time) the wait ends with it, so the queue does not hold for a card
   * nobody waits on, and nothing is done whatever the answer.
   * @template T
   * @param {Tab} tab
   * @param {Promise<T>} p
   * @param {AbortSignal | null} [signal]
   * @returns {Promise<T>}
   * @this {BrowserTabs}
   */
  async awaitUser(tab, p, signal = null) {
    const site = siteOf(tab.url);
    const answer = await waitingForUser(signal ? untilAborted(p, signal) : p);
    if (signal?.aborted) throw callEnded();
    tab.check();
    const root = tab.kind === 'popup' ? tab.root : tab;
    if (tab.takenOver || root.takenOver)
      throw new ToolError(
        `The user took over ${root.takenOver ? root.id : tab.id} while being asked. Don't act on it again this turn.`,
        'taken_over',
      );
    if (tab.signin || root.signin) throw heldError(tab.signin ? tab : root);
    if (siteOf(tab.url) !== site)
      throw new ToolError(
        `${tab.id} moved to ${oneLine(tab.url, 300) || 'a blank page'} while the user was being asked about ${oneLine(site, 200) || 'a blank page'}. Look at the page again before acting.`,
        'tab_changed',
      );
    return answer;
  }

  /**
   * Runs `fn` alone on the tab (actions on one tab never interleave), bounded by ACTION_MS.
   * @this {BrowserTabs}
   */
  run(tab, fn) {
    // the action carries its call's (chat, turn) token: when its place in the queue comes, an action whose call was
    // stopped, or whose turn ended, meanwhile does nothing (../contract/actionGuard.cjs)
    const live = liveness();
    // a timed-out action can no longer reach the page (runAction), and a card it waits on does not count
    const p = tab.queue.then(() => {
      if (!live()) throw stopped('acting in the built-in browser');
      // a page that asks to confirm leaving it while this runs is left, as the agent asked (windows.cjs)
      tab.acting++;
      const done = () => tab.acting--;
      const action = runAction(fn, ACTION_MS);
      action.then(done, done);
      return action;
    });
    // the next action waits for this one to settle; its error reaches the caller through p
    tab.queue = Promise.allSettled([p]);
    return p;
  }
}

const callEnded = () => new ToolError('The call ended while the user was being asked, so nothing was done.', 'aborted');

/**
 * `p`, or a rejection as soon as `signal` aborts (the card itself stays until it is answered or the turn ends).
 * @template T
 * @param {Promise<T>} p
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function untilAborted(p, signal) {
  if (signal.aborted) return Promise.reject(callEnded());
  return new Promise((resolve, reject) => {
    const stop = () => reject(callEnded());
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** @param {BrowserTabs} host */
function turnOver(host, chatId) {
  for (const fn of host.turnEndListeners) {
    try {
      fn(chatId);
    } catch (error) {
      // one listener error must not stop the others
      noteIgnored('tell a listener the turn ended', error);
    }
  }
}

module.exports = { HostTabs, reveal, used };

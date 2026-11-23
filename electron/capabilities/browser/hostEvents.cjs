// Browser host event subscriptions, page dialog and responsiveness notifications, and driver status.
const { noteIgnored } = require('../../ignored.cjs');
const { oneLine } = require('./hostUtil.cjs');
const { tabOf } = require('./hostTabState.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */
/** @typedef {import('./host.cjs').Tab} Tab */

class HostEvents {
  /**
   * Calls `fn(chatId)` when a chat's turn ends or the chat is forgotten; returns a function that stops it.
   * @this {BrowserTabs}
   */
  onTurnEnd(fn) {
    this.turnEndListeners.add(fn);
    return () => this.turnEndListeners.delete(fn);
  }

  /**
   * Calls `fn(change)` as a download an agent-held tab saves goes: { tab, id, url, filename, status } with status
   * 'started', 'in_progress', then 'complete', 'canceled' or 'failed'. Returns a function that stops it.
   * @param {(change: { tab: Tab, id: string, url: string, filename: string, status: string }) => void} fn
   * @this {BrowserTabs}
   */
  onDownload(fn) {
    this.downloadListeners.add(fn);
    return () => this.downloadListeners.delete(fn);
  }

  /**
   * Calls `fn(change)` as something happens on one of the chats' pages that a backend speaking CDP (the Codex Browser
   * plugin's, iabBackend) tells its client: a page dialog (pageDialogs.cjs) opening or closing ({ tab, open, dialog,
   * result }), or a CDP event of MoPilot's own ({ tab, cdp: { method, params } }, a blocked app link). Returns a
   * function that stops it.
   * @param {(change: { tab: Tab, open?: boolean, dialog?: any, result?: { accept: boolean, value: any, by: string },
   *   cdp?: { method: string, params: any } }) => void} fn
   * @this {BrowserTabs}
   */
  onPageEvent(fn) {
    this.pageListeners.add(fn);
    return () => this.pageListeners.delete(fn);
  }

  /**
   * A page's own dialog opened (pageDialogs.cjs). On a chat's tab the agent sees it in its results and answers it
   * (handleDialog); an alert on a tab an agent drives now is accepted with a note, as before. The pane shows it to
   * the user meanwhile (windows.cjs), and the first answer wins.
   * @this {BrowserTabs}
   */
  pageDialogOpened(wc, dialog) {
    const tab = tabOf(this, wc);
    if (!tab) return;
    if (dialog.type === 'alert' && this.driver(wc)?.agent) {
      this.change(tab.chatId, `alert dialog on ${tab.id} accepted${dialog.message ? `: "${oneLine(dialog.message, 300)}"` : ''}`);
      this.o.dialogs?.answer(wc, dialog.id, true, null, 'agent');
      return;
    }
    tab.dialog = {
      type: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt,
      url: dialog.url,
      frame: dialog.frame,
      own: dialog.id,
    };
    for (const w of tab.dialogWaiters) w(tab.dialog);
    tab.dialogWaiters.clear();
    for (const fn of this.pageListeners) fn({ tab, open: true, dialog });
  }

  /**
   * A page's own dialog closed: answered by the user (the agent is told), by the agent, or gone with its page.
   * @this {BrowserTabs}
   */
  pageDialogClosed(wc, dialog, result) {
    const tab = tabOf(this, wc);
    if (!tab) return;
    if (tab.dialog?.own === dialog.id) tab.dialog = null;
    if (result.by === 'user')
      this.change(
        tab.chatId,
        `the user ${result.accept ? 'accepted' : 'dismissed'} the ${dialog.type} dialog on ${tab.id}${dialog.message ? ` ("${oneLine(dialog.message, 200)}")` : ''}`,
      );
    for (const fn of this.pageListeners) fn({ tab, open: false, dialog, result });
  }

  /**
   * A page stopped responding, or responds again (pageHang.cjs). While it is hung every result says so (state) and
   * the agent's calls on the tab fail at once (tab.send); once it responds, the next result says that too.
   * @this {BrowserTabs}
   */
  pageHung(wc, hung) {
    const tab = tabOf(this, wc);
    if (!tab) return;
    if (!hung) this.change(tab.chatId, `page_responsive ${tab.id} responds again`);
    this.emit(tab.chatId);
  }

  /**
   * Whether an agent's action on the page is under way now (not taken over): leaving the page is its doing.
   * @this {BrowserTabs}
   */
  acting(wc) {
    const tab = wc && tabOf(this, wc);
    return !!tab && tab.acting > 0 && !!this.driver(wc)?.agent;
  }

  /**
   * Whether a dialog the agent must answer is open on the page (a frame's own, over CDP, included).
   * @this {BrowserTabs}
   */
  dialogOpen(wc) {
    return !!(wc && tabOf(this, wc)?.dialog);
  }

  /**
   * Something happened on a chat's page that its agent should know (a blocked app link, a page left on its
   * action): `text(tabId)` goes with the chat's next result, and `cdp` (an event a CDP client sees, given the same
   * text) to the backends that speak CDP. Nothing for a page of no chat.
   * @param {any} wc
   * @param {(tabId: string) => string} text
   * @param {((text: string) => { method: string, params: any }) | null} [cdp]
   * @this {BrowserTabs}
   */
  notePage(wc, text, cdp = null) {
    const tab = wc && tabOf(this, wc);
    if (!tab) return;
    const said = text(tab.id);
    this.change(tab.chatId, said);
    if (cdp) for (const fn of this.pageListeners) fn({ tab, cdp: cdp(said) });
  }

  /**
   * What the pane shows about the chat's tabs changed (agentTabs.cjs broadcasts it).
   * @this {BrowserTabs}
   */
  emit(chatId) {
    try {
      this.o.onChange?.(chatId);
    } catch (error) {
      // a broadcast error must not fail the tab action
      noteIgnored("tell the windows a chat's tabs changed", error);
    }
  }

  /**
   * Who drives a page, for its web permission requests (webPermissions.cjs): the chat whose tab (or popup)
   * it is, and whether an agent holds it now (not taken over, no sign-in hand-off). Null for a page of no chat.
   * @this {BrowserTabs}
   */
  driver(wc) {
    const tab = wc && tabOf(this, wc);
    if (!tab) return null;
    const root = tab.kind === 'popup' ? tab.root : tab;
    const user = (t) => t.takenOver || !!t.signin;
    return { chatId: tab.chatId, tabId: tab.id, agent: (tab.held || root.held) && !user(tab) && !user(root) };
  }
}

module.exports = { HostEvents };

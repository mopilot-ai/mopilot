// Browser tab bookkeeping: per-chat state, selection, activity ordering, registration and removal.
const { endHandoff } = require('./userTurn.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { Tab } = require('./tab.cjs');
const { isViewTab } = require('./views.cjs');
const { keyOf } = require('./pageKey.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { ORPHANS_MAX, oneLine } = require('./hostUtil.cjs');
const { releaseNow } = require('./heldInput.cjs');
const { finalMark } = require('./agentTabMark.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */
/** @typedef {import('./host.cjs').Tab} Tab */

/** @param {BrowserTabs} host */
function chatState(host, chatId) {
  let c = host.chats.get(chatId);
  if (!c)
    host.chats.set(
      chatId,
      (c = { tabs: new Map(), selected: null, changes: [], revealed: null, revealOff: false, orphans: new Map(), gone: new Map() }),
    );
  return c;
}

/**
 * An agent action on a tab (a popup counts for the tab that opened it): the turn's most recent one is
 * its result tab, and the chat's last result is an ordinary tab again.
 * @param {BrowserTabs} host
 * @param {Tab} tab
 */
function used(host, tab) {
  // the popup keeps its own stamp too, so the turn end knows which window the agent finished in
  tab.used = ++host.useSeq;
  if (tab.kind === 'popup') tab.root.used = tab.used;
  let was = false;
  for (const t of chatState(host, tab.chatId).tabs.values()) {
    was ||= t.result;
    t.result = false;
  }
  if (was) host.emit(tab.chatId);
}

/**
 * Brings the tab an agent action targets to the front of its window's pane, once per tab and turn.
 * @param {BrowserTabs} host
 */
function reveal(host, tab) {
  if (tab.kind !== 'tab') return;
  const c = chatState(host, tab.chatId);
  if (c.revealOff || c.revealed === tab.id) return;
  c.revealed = tab.id;
  try {
    // automatic: the pane follows the agent, but a tab the user has seen does not reopen a pane they closed
    host.o.select(tab, { auto: true });
  } catch (error) {
    // revealing the tab in the pane is cosmetic
    noteIgnored('reveal the agent tab in the pane', error);
  }
}

/** Whether `tab` shows the page `wc` (a webContents or a backend). */
function samePage(tab, wc) {
  return keyOf(tab.backend) === keyOf(wc);
}

/** A window reported how its pane lays out the page `wc`; the report goes with the page. @param {BrowserTabs} host */
function setLayer(host, wc, layer) {
  const key = keyOf(wc);
  if (!host.layers.has(key)) wc.once('destroyed', () => host.layers.delete(key));
  host.layers.set(key, layer);
}

/** @param {BrowserTabs} host */
function tabOf(host, wc) {
  for (const c of host.chats.values()) for (const t of c.tabs.values()) if (samePage(t, wc) && !t.closed) return t;
  return null;
}

/** @param {BrowserTabs} host */
function addTab(host, chatId, init) {
  const c = chatState(host, chatId);
  const tab = new Tab(host, { chatId, ...init });
  c.tabs.set(tab.id, tab);
  tab.backend.once('destroyed', () => tabGone(host, tab));
  if (!c.selected || !c.tabs.get(c.selected)) setSelected(host, c, tab);
  host.emit(chatId);
  return tab;
}

/** @param {BrowserTabs} host */
function tabGone(host, tab) {
  if (tab.closed) return;
  tab.closed = true;
  endHandoff(host, tab, 'closed');
  const c = host.chats.get(tab.chatId);
  if (!c || c.tabs.get(tab.id) !== tab) return;
  c.tabs.delete(tab.id);
  // a <webview>'s page went without being closed (the pane was hidden or remounted): if it comes back
  // under the same key it is the same tab, and the turn end still closes it if the agent opened it.
  // A view's page only goes when it is closed.
  if (tab.kind === 'tab' && !tab.closing && !isViewTab(tab.backend)) {
    const key = tab.legacy ? '' : tab.id;
    c.orphans.delete(key);
    c.orphans.set(key, tab);
    if (c.orphans.size > ORPHANS_MAX) c.orphans.delete(c.orphans.keys().next().value);
  }
  // closed by its page (a sign-in popup after Allow) or the user, not by the tools: a later call naming it says so
  if (!tab.closing) {
    c.gone.set(tab.id, tab.kind === 'popup' ? tab.root.id : null);
    if (c.gone.size > ORPHANS_MAX) c.gone.delete(c.gone.keys().next().value);
  }
  host.change(tab.chatId, `tab_closed ${tab.id}`);
  if (c.selected === tab.id) {
    const rest = [...c.tabs.values()];
    c.selected = null;
    if (rest.length) setSelected(host, c, rest[rest.length - 1]);
  }
  host.emit(tab.chatId);
}

/** @param {BrowserTabs} host */
function setSelected(host, c, tab) {
  c.selected = tab.id;
  // the legacy sage_browser_* tools follow the chat's current tab
  if (tab.kind === 'tab') {
    try {
      host.o.onSelect?.(tab.chatId, tab.wc, tab.owner);
    } catch (error) {
      // the legacy tools just keep their old tab
      noteIgnored('move the legacy browser tools to the selected tab', error);
    }
  }
}

/**
 * The error for a call naming a tab the chat no longer has. One its page or the user closed is told apart from an
 * unknown id: an action that made the page close itself may well have worked, and the tab that opened it shows how.
 * @param {BrowserTabs} host
 */
function missingTab(host, chatId, tabId) {
  const id = oneLine(tabId, 80);
  const c = host.chats.get(chatId);
  if (!c?.gone.has(String(tabId)))
    return new ToolError(`No tab ${id} in this chat. Call browser_tabs_context to list this chat's tabs.`, 'bad_args');
  // the tab that opened it while it is still there, else the chat's current one
  const opener = c.gone.get(String(tabId));
  const look = opener && c.tabs.has(opener) ? opener : c.selected;
  return new ToolError(
    `Tab ${id} was closed by its own page or by the user, not by your tools. A sign-in popup closes itself once access is allowed, so the last action may have worked: ${look ? `read ${look}, which shows the result,` : 'call browser_tabs_context'} before trying again.`,
    'tab_closed',
  );
}

/**
 * The turn's end lets go of the chat's tabs while their commands still reach the page: the agent cursor goes, leaving each tab's
 * favicon this turn's deliverable/handoff mark until the user sees it (agentTabMark.cjs), and held keys and buttons come up. The tab
 * the agent finished on counts as deliverable, as ChatGPT's done tab does: in the user's Chrome the chat's tabs all stay, so it is the
 * one to look at (a tab only drawn on this turn has a mark to leave; agentCursor.cjs clears the rest).
 * @param {{ clear: (tab: Tab, final?: string | null) => unknown } | null | undefined} cursor
 * @param {Iterable<Tab>} tabs @param {number} ended the turns the chat ended before this one
 */
const letGo = (cursor, tabs, ended) => {
  const list = [...tabs];
  const last = list.filter((t) => !t.closed).reduce((a, t) => (a && a.used >= t.used ? a : t), /** @type {Tab | null} */ (null));
  return Promise.all(list.flatMap((t) => [cursor?.clear(t, finalMark(t, ended) ?? (t === last ? 'deliverable' : null)), releaseNow(t)]));
};

module.exports = { chatState, used, reveal, tabOf, addTab, tabGone, setSelected, missingTab, letGo, samePage, setLayer };

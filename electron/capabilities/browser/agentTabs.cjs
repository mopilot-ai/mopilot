// What the browser pane shows while an agent drives a tab, kept in main so every window sees the same
// thing whether or not the chat's window is open or focused: which tabs an agent is using this turn,
// which it opened, which the user took over, which it finished on (the result), and the site permission
// for each tab's page.
// Harness-neutral: the state comes from BrowserTabs (host.cjs), which every harness's browser_*
// calls go through.
//
// IPC: browser:agentTabs (a snapshot of every chat), browser:takeOver (Take over / Hand back),
// browser:stopAgent (Stop: ends the chat's hand-offs and stops its turn as Stop does), browser:paneHidden (the user hid the
// pane while an agent used it: no more automatic reveals this turn), browser:signinDone ("Done, continue" on a
// browser_request_signin hand-off, which sends "Done on <site>" into the chat: userTurn.cjs). Push: browser:agentTabsChanged with { chatId, tabs }.
const { originOf } = require('./origins.cjs');
const { deviceView } = require('./devices.cjs');
const { LOCAL_HOST, encodeTabKey, decodeTabKey } = require('./hostTabKey.cjs');
const { registerRemoteView } = require('./remoteView.cjs');
const { DESKTOP_TAB } = require('../hostDesktopTabs.cjs');

/**
 * The site permission the bar shows for a page: 'full' (the chat has Full access), 'write' (read and
 * write), 'read' (read only), 'denied' (denied in this chat), 'ask' (asks before the agent opens or
 * uses it), or null for a blank or non-web page.
 * @param {{ peek: Function, anchor?: Function } | null | undefined} grants
 */
function siteAccess(grants, url, chatId) {
  if (!grants || !originOf(url)) return null;
  const ctx = { chatId, segmentId: '' };
  try {
    const write = grants.peek(url, 'write', ctx);
    // a blocked page (siteRisk.cjs) is as unusable to the agent as a denied one
    if (write === 'denied' || write === 'blocked') return 'denied';
    // Full access doesn't cover a high-risk site: it asks like any other until allowed in the chat
    if (write === 'ok') return grants.anchor?.(ctx) === 'full' ? 'full' : 'write';
    const read = grants.peek(url, 'read', ctx);
    if (read === 'ok') return 'read';
    return read === 'denied' ? 'denied' : 'ask';
  } catch {
    return null;
  }
}

/**
 * One tab as the pane shows it. `tabKey` is the pane tab's key: the browser_* id, or null for the chat's original tab; on another Host
 * it also names the Host (hostTabKey.cjs), since the chat can have tabs on two Hosts after a continue.
 */
function tabView(tab, grants, hostId = LOCAL_HOST) {
  const url = tab.url;
  return {
    tabId: tab.id,
    tabKey: encodeTabKey(hostId, tab.legacy ? null : tab.id),
    ...(hostId === LOCAL_HOST ? {} : { hostId }),
    kind: tab.kind,
    active: !!tab.held,
    created: !!tab.created,
    mark: tab.mark || null,
    takenOver: !!tab.takenOver,
    // kept open after the turn as where the agent finished (an ordinary tab from its next action)
    result: !!tab.result,
    origin: originOf(url),
    access: siteAccess(grants, url, tab.chatId),
    // the user's turn (browser_request_signin): why, and whether the page asks for a credential ("Sign in to" rather than "Your turn on")
    signin: tab.signin ? { reason: tab.signin.reason, credential: !!tab.signin.credential } : null,
    // the user took that hand-off to their Chrome (browser/handoff.cjs): their turn is there now
    moved: !tab.signin && !!tab.signinMoved,
    // the device the agent emulates in it (browser_resize_window), shown in the pane's toolbar
    device: deviceView(tab.emulated),
  };
}

/** The pane's view of a chat's tabs on one Host (popups are their own windows: the pane shows only its tabs). */
function chatView(tabs, grants, chatId, hostId = LOCAL_HOST) {
  return tabs
    .list(chatId)
    .filter((t) => t.kind === 'tab')
    .map((t) => tabView(t, grants, hostId));
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {() => InstanceType<typeof import('./host.cjs').BrowserTabs> | null | undefined} o.tabs this Mac's tabs
 * @param {() => InstanceType<typeof import('./tabsByHost.cjs').TabsByHost> | null | undefined} [o.hosts] every Host's tabs (tabsByHost.cjs); this Mac's alone when absent
 * @param {() => any} o.grants OriginGrants
 * @param {(channel: string, payload: any) => void} o.broadcast to every window
 * @param {(chatId: string) => Promise<any> | any} o.stop stops the chat's turn (and pauses its goal), as Stop does
 * @param {(what: string, error: unknown) => void} [o.report] where a failure that is only noted goes (the remote view's input)
 * @param {() => { list(chatId: string): any[], chats(): string[], takeOver(chatId: string, on: boolean): boolean } | null | undefined} [o.desktops] the chats' desktops on Hosts (hostDesktopTabs.cjs), listed beside their browser tabs
 * @param {(fn: () => void) => void} [o.defer] coalesces bursts of changes (default setImmediate)
 * @returns {{ changed(chatId: string): void, snapshot(): Record<string, ReturnType<typeof chatView>> }}
 */
function registerAgentTabs(o) {
  const defer = o.defer || ((fn) => setImmediate(fn));
  const pending = new Set();
  /** Every Host's tabs as [hostId, tabs]: this Mac's, and the Hosts a chat's agent worked on. */
  const sources = () => {
    const tabs = o.tabs();
    return o.hosts?.()?.entries() ?? (tabs ? [[LOCAL_HOST, tabs]] : []);
  };
  /** The tabs a pane key names, on the Host it names (never made here: a key for a Host with no tabs names nothing). */
  const tabsOf = (/** @type {string} */ hostId) => {
    const router = o.hosts?.();
    return router ? router.existing(hostId) : hostId === LOCAL_HOST ? o.tabs() : null;
  };
  const viewOf = (/** @type {string} */ chatId) => [
    ...sources().flatMap(([hostId, tabs]) => chatView(tabs, o.grants(), chatId, hostId)),
    ...(o.desktops?.()?.list(chatId) ?? []),
  ];
  const flush = () => {
    const ids = [...pending];
    pending.clear();
    // no browser host yet: nothing to tell
    if (!sources().length) return;
    for (const chatId of ids) o.broadcast('browser:agentTabsChanged', { chatId, tabs: viewOf(chatId) });
  };
  const changed = (chatId) => {
    if (typeof chatId !== 'string' || !chatId) return;
    if (!pending.size) defer(flush);
    pending.add(chatId);
  };
  const snapshot = () => {
    const out = {};
    for (const chatId of new Set([...sources().flatMap(([, tabs]) => [...tabs.chats.keys()]), ...(o.desktops?.()?.chats() ?? [])])) {
      const list = viewOf(chatId);
      if (list.length) out[chatId] = list;
    }
    return out;
  };
  const chatArg = (chatId) => (typeof chatId === 'string' && chatId ? chatId : null);
  o.ipcMain.handle('browser:agentTabs', () => snapshot());
  o.ipcMain.handle('browser:takeOver', (_e, chatId, tabKey, on) => {
    const id = chatArg(chatId);
    const key = decodeTabKey(tabKey);
    // a Host's desktop is taken over here, not in a browser's tabs
    if (id && key.tabKey === DESKTOP_TAB && key.hostId !== LOCAL_HOST) return !!o.desktops?.()?.takeOver(id, on !== false);
    return !!id && !!tabsOf(key.hostId)?.takeOver(id, key.tabKey, on !== false);
  });
  o.ipcMain.handle('browser:stopAgent', async (_e, chatId) => {
    const id = chatArg(chatId);
    if (!id) return false;
    // Stop on a tab that is the user's turn ends the hand-off even when no turn runs
    for (const [, tabs] of sources()) tabs.endHandoffs(id, 'stopped');
    await o.stop(id);
    return true;
  });
  o.ipcMain.handle('browser:signinDone', async (_e, chatId, tabId, done) => {
    const id = chatArg(chatId);
    const key = decodeTabKey(tabId);
    return !!id && !!(await tabsOf(key.hostId)?.signinDone(id, key.tabKey, done !== false));
  });
  o.ipcMain.handle('browser:paneHidden', (_e, chatIds) => {
    if (!Array.isArray(chatIds) || !sources().length) return false;
    for (const [, tabs] of sources()) for (const id of chatIds) if (chatArg(id)) tabs.paneHidden(id);
    return true;
  });
  // a tab on a Host is seen in the pane by its frames (remoteView.cjs)
  registerRemoteView({ ipcMain: o.ipcMain, hosts: () => o.hosts?.(), report: o.report });
  return { changed, snapshot };
}

module.exports = { registerAgentTabs, siteAccess, tabView, chatView };

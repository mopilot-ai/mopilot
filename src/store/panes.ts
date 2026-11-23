// Routes (navigate, back, forward) and side pane tabs, including the agent browser tabs a chat opens. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { identityKey } from '../../shared/identityKey.mjs';
import type { AppState, FindingsWalk, PaneTab } from './state';
import { chatPaneForView, parkChatPane } from './chatPanes';
import { applySplit, focusedChat, focusPrimary, primaryChat, pruneSplitOwners, type SplitLayout } from './split';
import { replaceBlankPaneTab } from './sideChat';
import { paneOpensFull } from '../lib/paneLayout';
import { withAgentTabs, agentChatsUsing, viewChats, inView, frontTab, shownTabs, agentTabFor } from '../lib/agentTabs';
import { isDesktopTabKey } from '../lib/hostTabKey';
import { closedBrowserPanes } from '../lib/browserView';
import { native } from '../lib/native';
import { confirmDiscard } from '../lib/fileDrafts';
import { workspacesShowing } from '../lib/filesWorkspace';
import { isEnabled } from '../lib/flags';
import { noteIgnored, errorText } from '../lib/ignored';
import type { Route } from './types';
import { toast, get, set, useStore } from './core';
import { chatOf } from './chats';
import { quickChatSurface } from './boot';
import { showThread } from './threads';
import { openArtifactTab } from './artifactPanes';
import { deletionVisibility } from './deletionVisibility';

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */
const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

/** The window's view moving to `route` and `split` at once, with the side pane following the focused chat. */
const viewPatch = (s: AppState, route: Route, split: SplitLayout) => ({ ...chatPaneForView(s, { route, split }, chatOf), route, split });

/**
 * Shows `route` in the primary pane, which takes focus. A chat already in a split moves here; agent panes whose source
 * left the view close. Explicit user splits remain until the user closes them or opens their chat here.
 */
export function navigate(route: Route) {
  if (quickChatSurface && route.name === 'settings') {
    void native.win.quickChatSettings(route.section).then(
      (r) => {
        if (!r.ok) toast(r.error ?? 'Could not open settings', 'error');
      },
      (e) => toast(errorText(e), 'error'),
    );
    return;
  }
  const s = get();
  const split = historySplit(s, route);
  if (sameRoute(s.route, route)) {
    if (split !== s.split) set(viewPatch(s, s.route, split));
    return;
  }
  set({ ...viewPatch(s, route, split), back: [...s.back, s.route].slice(-100), forward: [] });
  if (route.name === 'thread') showThread(route.id);
}

/** Navigation and history share promotion and owner cleanup; Settings only hides the current layout temporarily. */
function historySplit(s: AppState, route: Route): SplitLayout {
  const layout = route.name === 'thread' ? applySplit(s.split, null, { op: 'retire', chatId: route.id }).layout : s.split;
  return focusPrimary(route.name === 'settings' ? layout : pruneSplitOwners(layout, primaryChat({ route })));
}
/** A chat that was deleted: history never goes back to it. */
const deletedChat = (r: Route) => r.name === 'thread' && deletionVisibility.has(r.id);
export function goBack() {
  const s = get();
  if (!s.back.length) return;
  // the entries of chats deleted since are passed over; with none left before them, Home
  const at = s.back.findLastIndex((r) => !deletedChat(r));
  const prev: Route = at < 0 ? { name: 'home' } : s.back[at];
  set({ ...viewPatch(s, prev, historySplit(s, prev)), back: at < 0 ? [] : s.back.slice(0, at), forward: [s.route, ...s.forward] });
  if (prev.name === 'thread') showThread(prev.id);
}
/** A chat history can't show again: deleted, or archived (an open chat need not be in the sidebar's loaded `threads`). */
const goneChat = (s: AppState, r: Route) =>
  r.name === 'thread' && (deletionVisibility.has(r.id) || typeof s.claudeArchived[r.id] === 'number');

/**
 * Settings' Back to app (its row, Esc, ⌘, again): back past every Settings page to the view it was opened from, else
 * Home, with the pages passed over in forward history; a chat deleted or archived meanwhile is passed over too.
 */
export function leaveSettings() {
  const s = get();
  if (s.route.name !== 'settings') return;
  const at = s.back.findLastIndex((r) => r.name !== 'settings' && !goneChat(s, r));
  const prev: Route = at < 0 ? { name: 'home' } : s.back[at];
  set({
    ...viewPatch(s, prev, historySplit(s, prev)),
    back: at < 0 ? [] : s.back.slice(0, at),
    forward: [...s.back.slice(at + 1), s.route, ...s.forward],
  });
  if (prev.name === 'thread') showThread(prev.id);
}
export function goForward() {
  const s = get();
  const at = s.forward.findIndex((r) => !deletedChat(r));
  // what lies ahead is all deleted chats: it is dropped, and the view stays
  if (at < 0) return void (s.forward.length && set({ forward: [] }));
  const next = s.forward[at];
  set({ ...viewPatch(s, next, historySplit(s, next)), forward: s.forward.slice(at + 1), back: [...s.back, s.route] });
  if (next.name === 'thread') showThread(next.id);
}

/** Start a new chat for the composer's current target (project, folder, worktree) and open it. */
/** The pane tab for an agent's browser tab: `tabKey` null is the chat's original tab, undefined any of its tabs. */
function findAgentBrowserTab(tabs: PaneTab[], chatId: string, tabKey?: string | null) {
  const mine = tabs.filter((t) => t.kind === 'browser' && t.agentChat === chatId);
  if (tabKey === undefined) return mine.find((t) => !t.agentTab) ?? mine[0];
  return mine.find((t) => (tabKey ? t.agentTab === tabKey : !t.agentTab));
}

/** The tab a caller names: a key, or undefined for any of the chat's tabs (an empty or null key names none). */
/** What the side pane's view reads of the window: the route, the split layout, and the pane's tabs. */
type ViewOf = Pick<AppState, 'route' | 'paneTabs'> & Partial<Pick<AppState, 'split'>>;

const agentTabKey = (tabKey?: string | null) => (typeof tabKey === 'string' && tabKey ? tabKey : undefined);
/** A Host chat's desktop tab is titled by its machine, not by the chat. */
const desktopTitle = (s: Pick<AppState, 'agentTabs'>, chatId: string, tabKey?: string) =>
  isDesktopTabKey(tabKey)
    ? `Desktop on ${agentTabFor(s.agentTabs, chatId, tabKey as string)?.desktop?.machine ?? 'the other machine'}`
    : null;

/** Whether the window shows `chatId`'s agent browser tabs: they belong to that chat's view only. */
function agentChatInView(s: ViewOf, chatId: string) {
  return inView({ kind: 'browser', agentChat: chatId }, windowChats(s), chatOf);
}

/** The chats the side pane's view shows: the focused chat and the side chats in its pane. */
const windowChats = (s: ViewOf) => viewChats(focusedChat(s), s.paneTabs);

/**
 * Whether a pane tab's page needs the pane open to exist: a <webview> attaches only in an open pane, while a
 * main-owned view (shared.browser.viewTabs) lives in main whether or not any pane shows it.
 */
const pageNeedsOpenPane = () => !isEnabled('shared.browser.viewTabs');

/** The pane state a tab mounted behind leaves: unchanged, unless its <webview> needs the pane open to exist. */
function behind(s: Pick<AppState, 'diffPanel'>): Partial<AppState> {
  return pageNeedsOpenPane() ? { diffPanel: { ...s.diffPanel, open: true } } : {};
}

/**
 * Whether an automatic request (`auto`: the agent's reveal, its turn's result, browser_tabs_select) leaves the pane
 * closed: the user has seen this tab, so a closed pane is theirs (as Claude Desktop treats a pane the user closed).
 * The agent's pace still moves the front tab while the pane is open.
 */
const keepsClosed = (s: Pick<AppState, 'diffPanel'>, tab: PaneTab, auto?: boolean) => !!auto && !s.diffPanel.open && !!tab.seen;

/** Whether what the side pane shows may have changed: its tabs, front tab, open state, route or split focus. */
const paneViewChanged = (s: AppState, prev: AppState) =>
  s.paneTabs !== prev.paneTabs ||
  s.paneActive !== prev.paneActive ||
  s.diffPanel !== prev.diffPanel ||
  s.route !== prev.route ||
  s.split !== prev.split;

/** The agent tab in front of this view's open pane, marked seen the first time it is there; null when nothing changes. */
export function seenPatch(s: ViewOf & Pick<AppState, 'paneActive' | 'diffPanel'>): Pick<AppState, 'paneTabs'> | null {
  // the pane is drawn beside a chat or the home page only (src/components/panels/SidePaneSlot.tsx)
  if (!s.diffPanel.open || (s.route.name !== 'thread' && s.route.name !== 'home')) return null;
  const front = frontTab(s.paneTabs, s.paneActive, windowChats(s), chatOf);
  const tab = s.paneTabs.find((t) => t.id === front);
  if (!tab || tab.kind !== 'browser' || !tab.agentChat || tab.seen) return null;
  return { paneTabs: s.paneTabs.map((t) => (t === tab ? { ...t, seen: true } : t)) };
}

/**
 * Shows the browser tab an agent's chat drives, opening a blank one if it has none. With a tabKey
 * (browser_tabs_create) the tab is that one; `focus: false` mounts it without taking over the pane.
 * `after`: a duplicate's source (its key, null for the chat's original tab), which a new tab is placed beside.
 * Another chat's tab is mounted but never shown in this chat's view, and leaves this view's pane as it is.
 */
export function openAgentBrowserTab(
  chatId: string,
  opts: { tabKey?: string | null; focus?: boolean; after?: string | null; auto?: boolean } = {},
) {
  const s = get();
  const tabKey = agentTabKey(opts.tabKey);
  const shown = agentChatInView(s, chatId);
  const tab = findAgentBrowserTab(s.paneTabs, chatId, tabKey);
  if (tab && shown && keepsClosed(s, tab, opts.auto)) return;
  if (tab) return set(shown ? { paneActive: tab.id, diffPanel: { ...s.diffPanel, open: true } } : behind(s));
  const extra = {
    url: 'about:blank',
    title: desktopTitle(s, chatId, tabKey) ?? (s.threads[chatOf(chatId)]?.name || 'Agent browser'),
    agentChat: chatId,
    ...(tabKey ? { agentTab: tabKey } : {}),
  };
  if (!shown) {
    // another chat's tab: its page mounts without changing what this view shows
    set({ paneTabs: [...s.paneTabs, { id: `browser-${crypto.randomUUID()}`, kind: 'browser', ...extra }], ...behind(s) });
  } else if (opts.focus === false && s.diffPanel.open && s.paneTabs.length && tabKey) {
    // background in this chat's open pane: the page mounts behind the tab in front
    set({ paneTabs: [...s.paneTabs, { id: `browser-${crypto.randomUUID()}`, kind: 'browser', ...extra }] });
  } else openPaneTab('browser', extra);
  if (tabKey && opts.after !== undefined) placeAfter(chatId, tabKey, opts.after);
}

/** Moves the chat's tab `tabKey` right after its tab `after` (a duplicate beside its source), when both are in the pane. */
function placeAfter(chatId: string, tabKey: string, after: string | null) {
  set((s) => {
    const mine = (t: PaneTab) => t.kind === 'browser' && t.agentChat === chatId && t.agentTab === tabKey;
    const rest = s.paneTabs.filter((t) => !mine(t));
    const source = findAgentBrowserTab(rest, chatId, after);
    const at = source ? rest.indexOf(source) + 1 : 0;
    return at ? { paneTabs: [...rest.slice(0, at), ...s.paneTabs.filter(mine), ...rest.slice(at)] } : {};
  });
}

/**
 * Whether openAgentBrowserTab (in front, as a button asks) would change what the user sees. It would not when the
 * pane is open with that tab already in front, or when the tab belongs to a chat this view never shows (it only
 * mounts behind), so a button offering it then is a dead end and is left out (CM-K18, E-X1).
 */
export function agentBrowserTabOpens(
  s: ViewOf & Pick<AppState, 'paneActive' | 'diffPanel'>,
  chatId: string,
  opts: { tabKey?: string | null } = {},
): boolean {
  // another chat's tab mounts behind, leaving this view's pane as it is (unless its <webview> must open the pane)
  if (!agentChatInView(s, chatId)) return !s.diffPanel.open && pageNeedsOpenPane();
  if (!s.diffPanel.open) return true;
  const tab = findAgentBrowserTab(s.paneTabs, chatId, agentTabKey(opts.tabKey));
  return !tab || frontTab(s.paneTabs, s.paneActive, windowChats(s), chatOf) !== tab.id;
}

/**
 * main's view of agent control of browser tabs, in every window whether or not it shows the chat.
 * When the user hides the pane while an agent is using one of its tabs, main stops revealing the
 * chat's tabs for the rest of that turn.
 */
export function startAgentTabs() {
  const b = native.browser;
  b.onAgentTabs(({ chatId, tabs }) => set((s) => ({ agentTabs: withAgentTabs(s.agentTabs, chatId, tabs) })));
  // pushes that arrived before the snapshot are newer than it
  b.agentTabs().then(
    (all) => set((s) => ({ agentTabs: { ...all, ...s.agentTabs } })),
    () => {
      /* the pushes above keep the map current without the snapshot */
    },
  );
  useStore.subscribe((s, prev) => {
    const seen = paneViewChanged(s, prev) ? seenPatch(s) : null;
    if (seen) set(seen);
    // a closed browser pane tab's page goes (main owns it as a view; a <webview> goes with the pane)
    if (s.paneTabs !== prev.paneTabs)
      // the page may be gone already
      for (const id of closedBrowserPanes(prev.paneTabs, s.paneTabs))
        b.view.close(id).catch((error) => noteIgnored("close a closed pane tab's page", error));
    if (!prev.diffPanel.open || s.diffPanel.open) return;
    const chats = agentChatsUsing(s.paneTabs, s.agentTabs);
    if (chats.length)
      // main keeps revealing the tabs, as before the pane was hidden
      b.paneHidden(chats).catch((error) => noteIgnored('tell main the browser pane was hidden', error));
  });
}

/**
 * A pane tab for a page main already opened (a view tab's popup, window.open or target=_blank):
 * `paneId` names its view, so the tab shows that page rather than loading the address again.
 */
export function openBrowserViewTab(req: unknown) {
  const r = (req ?? {}) as { paneId?: unknown; url?: unknown; title?: unknown; opener?: unknown };
  if (typeof r.paneId !== 'string' || !r.paneId || typeof r.url !== 'string') return;
  const s = get();
  // the popup belongs to its opener's chat, which may not be the chat on screen now
  const opener = typeof r.opener === 'string' ? s.paneTabs.find((t) => t.id === r.opener) : undefined;
  const openerChat = opener && (opener.agentChat ?? opener.ownerChat);
  const owner: Pick<PaneTab, 'ownerChat'> = opener ? (openerChat ? { ownerChat: openerChat } : {}) : ownerOf(s);
  const existing = s.paneTabs.find((t) => t.id === r.paneId);
  const tab: PaneTab = existing ?? {
    id: r.paneId,
    kind: 'browser',
    url: r.url,
    title: typeof r.title === 'string' && r.title ? r.title : r.url,
    ...owner,
  };
  const tabs = existing ? s.paneTabs : [...s.paneTabs, tab];
  if (!inView(tab, windowChats({ ...s, paneTabs: tabs }), chatOf)) return set({ paneTabs: tabs, ...behind(s) });
  set({ paneTabs: tabs, paneActive: r.paneId, diffPanel: { ...s.diffPanel, open: true } });
}

/** Closes an agent's browser tab (browser_tabs_close, or the end of the turn that opened it). */
export function closeAgentBrowserTab(chatId: string, tabKey: string | null) {
  const tab = findAgentBrowserTab(get().paneTabs, chatId, tabKey);
  if (tab) closePaneTab(tab.id);
}

/**
 * Brings an agent's browser tab to the front (browser_tabs_select, or input to a hidden tab) in its
 * chat's view. In another chat's view it stays out of sight: the pane paints it behind while the agent drives it.
 */
export function selectAgentBrowserTab(chatId: string, tabKey: string | null, auto = false) {
  const s = get();
  const tab = findAgentBrowserTab(s.paneTabs, chatId, tabKey);
  if (tab && agentChatInView(s, chatId) && !keepsClosed(s, tab, auto)) showPaneTab(tab.id);
}

/** Show a retained tab in the current view, defaulting to the tab that view already displays. */
export function showPaneTab(id?: string) {
  const s = get();
  const chats = windowChats(s);
  const active = id ?? frontTab(s.paneTabs, s.paneActive, chats, chatOf);
  const tab = s.paneTabs.find((t) => t.id === active && inView(t, chats, chatOf));
  if (tab) set({ paneActive: tab.id, diffPanel: { ...s.diffPanel, open: true } });
}

/** The focused chat owns the tabs the user opens: they show in its view only, like Codex's per-conversation pane. */
function ownerOf(s: AppState): Pick<PaneTab, 'ownerChat'> {
  const chatId = focusedChat(s);
  return chatId ? { ownerChat: chatId } : {};
}
const OWNED_KINDS: PaneTab['kind'][] = ['browser', 'terminal', 'file', 'skill', 'plan', 'outputs', 'usage'];

/** Open (or focus) a tab, or convert a blank browser tab in place. */
export function openPaneTab(kind: PaneTab['kind'], extra: Partial<PaneTab> = {}, replaceTabId?: string) {
  const s = get();
  // a claude.ai artifact or design is its own tab, in the profile signed in to claude.ai (artifactPanes.ts)
  if (kind === 'browser' && !replaceTabId && !extra.agentChat && extra.url && openArtifactTab({ url: extra.url }, extra.ownerChat)) return;
  if (OWNED_KINDS.includes(kind) && !extra.agentChat) extra = { ...ownerOf(s), ...extra };
  // a file opened at a line without an end is that line alone, not the range an earlier open left on its tab
  if (kind === 'file' && extra.line !== undefined && !('endLine' in extra)) extra = { ...extra, endLine: undefined };
  if (kind === 'chat') extra = { ...extra, sourceChatId: extra.sourceChatId ?? focusedChat(s) ?? undefined };
  if (replaceTabId) {
    const tabs = replaceBlankPaneTab(s.paneTabs, kind, extra, replaceTabId);
    if (!tabs) return;
    const tab = tabs.find((t) => t.id === replaceTabId)!;
    const parked = kind === 'chat' ? parkChatPane({ ...s, paneTabs: tabs }, tab) : undefined;
    set(
      parked ?? {
        paneTabs: tabs,
        paneActive: replaceTabId,
        diffPanel: { ...s.diffPanel, open: true },
        paneFull: paneOpensFull(kind, s.diffPanel.open, s.paneFull, s.prefs.fullViewDefault),
      },
    );
    return;
  }
  const pathTab = kind === 'skill' || kind === 'file';
  const multi = kind === 'browser' || kind === 'terminal' || kind === 'chat' || pathTab;
  const existing =
    kind === 'plan' || kind === 'outputs' || kind === 'usage'
      ? s.paneTabs.find((t) => t.kind === kind && t.ownerChat === extra.ownerChat)
      : pathTab
        ? s.paneTabs.find((t) => t.kind === kind && t.path === extra.path && t.ownerChat === extra.ownerChat)
        : multi
          ? null
          : s.paneTabs.find((t) => t.kind === kind);
  const tab: PaneTab = existing
    ? { ...existing, ...extra }
    : {
        id: pathTab ? identityKey(kind, extra.ownerChat ?? null, extra.path ?? null) : multi ? `${kind}-${crypto.randomUUID()}` : kind,
        kind,
        ...extra,
      };
  const parked = kind === 'chat' ? parkChatPane(s, tab) : undefined;
  if (parked) return set(parked);
  const tabs = existing ? s.paneTabs.map((t) => (t.id === existing.id ? tab : t)) : [...s.paneTabs, tab];
  // Side chats and file/skill details keep the main conversation visible.
  const full = paneOpensFull(kind, s.diffPanel.open, s.paneFull, s.prefs.fullViewDefault);
  set({ paneTabs: tabs, paneActive: tab.id, diffPanel: { ...s.diffPanel, open: true }, paneFull: full });
}
/** Show the Changes tab, optionally scoped to a file or turn. */
export function openChanges(extra: { file?: string | null; scope?: string; turnId?: string; walk?: FindingsWalk } = {}) {
  const s = get();
  const tabs = s.paneTabs.some((t) => t.kind === 'changes') ? s.paneTabs : [{ id: 'changes', kind: 'changes' as const }, ...s.paneTabs];
  set({ paneTabs: tabs, paneActive: 'changes', diffPanel: { open: true, ...extra } });
}
/**
 * The files whose last view closes with `closing` and so may lose unsaved edits (file tabs edit in place): a file another
 * remaining tab or a Files tab still shows keeps its edit, for one discard question.
 */
function editedPaths(tabs: readonly PaneTab[], closing: readonly PaneTab[]) {
  const staying = tabs.filter((t) => !closing.includes(t));
  return closing.flatMap((t) =>
    t.kind === 'file' && t.path && !staying.some((o) => o.kind === 'file' && o.path === t.path) && !workspacesShowing(t.path, '')
      ? [t.path]
      : [],
  );
}

export function closePaneTab(id: string) {
  const s = get();
  // a file with unsaved edits closes only once the user agrees to lose them
  if (
    !confirmDiscard(
      editedPaths(
        s.paneTabs,
        s.paneTabs.filter((t) => t.id === id),
      ),
    )
  )
    return;
  const tabs = s.paneTabs.filter((t) => t.id !== id);
  if (!tabs.length) return set({ paneTabs: [], paneActive: '', diffPanel: { open: false } });
  // only other chats' agent tabs remain: hide the pane (they stay for their chat) instead of letting
  // the empty pane reopen Changes
  const chats = viewChats(focusedChat(s), tabs);
  if (!tabs.some((t) => inView(t, chats, chatOf))) return set({ paneTabs: tabs, paneActive: '', diffPanel: { open: false } });
  set({ paneTabs: tabs, paneActive: s.paneActive === id ? tabs[tabs.length - 1].id : s.paneActive });
}
/** The tab menu's Close other tabs / Close tabs to the right: only tabs this view shows, and `id` stays in front. */
export function closeOtherPaneTabs(id: string, which: 'others' | 'right') {
  const s = get();
  const shown = shownTabs(s.paneTabs, windowChats(s), chatOf);
  const at = shown.findIndex((t) => t.id === id);
  if (at < 0) return;
  const closing = which === 'others' ? shown.filter((t) => t.id !== id) : shown.slice(at + 1);
  if (!confirmDiscard(editedPaths(s.paneTabs, closing))) return;
  const gone = new Set(closing.map((t) => t.id));
  set({ paneTabs: s.paneTabs.filter((t) => !gone.has(t.id)), paneActive: gone.has(s.paneActive) ? id : s.paneActive });
}
/** The tab menu's New tab to the right: a blank browser tab right after `id`, in front. */
export function openBrowserTabAfter(id: string) {
  if (!get().paneTabs.some((t) => t.id === id)) return;
  openPaneTab('browser');
  set((s) => {
    const added = s.paneTabs.find((t) => t.id === s.paneActive)!;
    const rest = s.paneTabs.filter((t) => t !== added);
    const at = rest.findIndex((t) => t.id === id) + 1;
    return { paneTabs: [...rest.slice(0, at), added, ...rest.slice(at)] };
  });
}
/** The tab menu's Rename: a name the page's own title no longer replaces; a blank one gives the page title back. */
export function renamePaneTab(id: string, name: string) {
  const customTitle = name.trim() || undefined;
  set((s) => ({ paneTabs: s.paneTabs.map((t) => (t.id === id ? { ...t, customTitle } : t)) }));
}
/** A deleted chat takes the browser, terminal and file tabs it owned with it, so their pages and shells end. */
export function closeOwnedPaneTabs(chatId: string) {
  const s = get();
  const tabs = s.paneTabs.filter((t) => t.ownerChat !== chatId);
  if (tabs.length === s.paneTabs.length) return;
  set({
    paneTabs: tabs,
    paneActive: tabs.some((t) => t.id === s.paneActive) ? s.paneActive : '',
    ...(tabs.length ? {} : { diffPanel: { open: false } }),
  });
}
export function togglePaneTab(kind: PaneTab['kind']) {
  const s = get();
  const active = s.paneTabs.find((t) => t.id === s.paneActive);
  // another chat's tab left in front is not what this chat's pane shows
  if (s.diffPanel.open && active?.kind === kind && inView(active, windowChats(s), chatOf)) return set({ diffPanel: { open: false } });
  openPaneTab(kind);
}

/* ------------------------------------------------------------------ */
/* tasks tab and agent pages                                          */
/* ------------------------------------------------------------------ */
const tasksTab = (s: AppState) => s.paneTabs.find((t) => t.kind === 'tasks');

/** The Background tasks tab for a chat: open it on its list, or close the pane when it is already in front. */
export function toggleTasksPane(chatId: string) {
  const s = get();
  const tab = tasksTab(s);
  if (s.diffPanel.open && tab && s.paneActive === tab.id && tab.threadId === chatId && !tab.views?.length)
    return set({ diffPanel: { open: false } });
  openPaneTab('tasks', { threadId: chatId, views: [] });
}

/** Open an agent's page in the tasks tab, over whatever it shows (an agent already open moves to the top). */
export function openAgentPage(chatId: string, key: string, title: string) {
  const tab = tasksTab(get());
  const keep = tab?.threadId === chatId ? (tab.views ?? []).filter((v) => v.key !== key) : [];
  openPaneTab('tasks', { threadId: chatId, views: [...keep, { kind: 'agent', key, title }] });
}

/** Back from the page in front of the tasks tab. */
export function popPaneView(tabId: string) {
  set((s) => ({ paneTabs: s.paneTabs.map((t) => (t.id === tabId ? { ...t, views: (t.views ?? []).slice(0, -1) } : t)) }));
}

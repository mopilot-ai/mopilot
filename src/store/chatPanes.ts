// Per-chat right-pane layout: saving and restoring visibility, Changes targets and temporary chat tabs as the focused chat changes.

import { inView, viewChats } from '../lib/agentTabs';
import type { AppState, PaneTab } from './state';
import { focusedChat, type SplitLayout } from './split';
import type { Route } from './types';

export type ChatPaneState = Pick<AppState, 'route' | 'paneTabs' | 'paneActive' | 'chatPanes' | 'diffPanel' | 'paneFull' | 'summaryOpen'> &
  Partial<Pick<AppState, 'split'>>;

/**
 * Resource tabs keep their pages/shells mounted; ordinary panels and side chats travel with their session. The Files
 * tab is the window's: it stays open when the user switches sessions (as Claude Desktop's Files panel does), showing
 * the folder of the session in view.
 */
const parkedWithChat = (tab: PaneTab) => ['chat', 'changes', 'tasks'].includes(tab.kind);

/**
 * The side pane follows the focused pane: when the window's view changes (a navigation, or focus moving between split
 * panes), the chat that had focus parks its own tabs and the one that takes it gets its own back. Side chats are
 * parked here, while the browser, terminal and file tabs a chat owns stay mounted and are filtered by `inView`. Other
 * pane tabs stay in this window.
 */
export function chatPaneForView(
  s: ChatPaneState,
  next: { route: Route; split: SplitLayout },
  chatOf = (id: string) => id,
): Partial<ChatPaneState> {
  const from = focusedChat(s);
  const to = focusedChat(next);
  if (from === to) return {};
  const chats = s.paneTabs.filter(parkedWithChat);
  const globals = s.paneTabs.filter((t) => !parkedWithChat(t));
  const chatPanes = { ...s.chatPanes };
  if (from)
    chatPanes[from] = {
      tabs: chats,
      active: s.paneActive,
      open: s.diffPanel.open,
      full: s.paneFull,
      panel: s.diffPanel,
      summaryOpen: s.summaryOpen,
    };
  const saved = to ? chatPanes[to] : undefined;
  const tabs = [...globals, ...(saved?.tabs ?? [])];
  const chatsInView = viewChats(to, saved?.tabs ?? []);
  const visible = (t: PaneTab) => inView(t, chatsInView, chatOf);
  // Files open in front stays in front, open, in the session the user moves to (not on home, which has no session)
  const filesKept = !!to && s.diffPanel.open && s.paneTabs.some((t) => t.id === s.paneActive && t.kind === 'files');
  const fallback = globals.filter(visible).at(-1)?.id ?? saved?.tabs.at(-1)?.id ?? '';
  const restored = saved && tabs.some((t) => t.id === saved.active && visible(t)) ? saved.active : fallback;
  const active = filesKept ? s.paneActive : restored;
  // the window's Files tab is open only while it is open in the view the user comes from: closing it in one session
  // does not leave it open in the one they go back to
  const savedFiles = !filesKept && tabs.some((t) => t.id === active && t.kind === 'files');
  const open = filesKept || (!!active && !savedFiles && (saved?.open ?? false));
  return {
    chatPanes,
    paneTabs: tabs,
    paneActive: active,
    diffPanel: { ...saved?.panel, open },
    paneFull: filesKept ? s.paneFull : !!saved && open && saved.full,
    summaryOpen: saved?.summaryOpen ?? true,
  };
}

/** A delayed fork stays with its source chat instead of taking over the focused chat's pane. */
export function parkChatPane(s: ChatPaneState, tab: PaneTab): Partial<ChatPaneState> | undefined {
  const source = tab.sourceChatId;
  if (!source || focusedChat(s) === source) return;
  const saved = s.chatPanes[source];
  const tabs = (saved?.tabs ?? []).filter((t) => t.id !== tab.id);
  const visible = s.paneTabs.filter((t) => t.id !== tab.id);
  const active = s.paneActive === tab.id ? (visible.at(-1)?.id ?? '') : s.paneActive;
  return {
    chatPanes: { ...s.chatPanes, [source]: { ...saved, tabs: [...tabs, tab], active: tab.id, open: true, full: false } },
    paneTabs: visible,
    paneActive: active,
    diffPanel: { ...s.diffPanel, open: visible.length > 0 && s.diffPanel.open },
    paneFull: visible.length > 0 && s.paneFull,
  };
}

/** Selection requests can reuse a side chat even if its parent was deselected during a fork. */
export function chatTabsFor(s: ChatPaneState, chatId: string): PaneTab[] {
  return focusedChat(s) === chatId ? s.paneTabs : (s.chatPanes[chatId]?.tabs ?? []);
}

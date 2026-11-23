// The browser pane's view of agent control, from main's snapshot (electron/capabilities/browser/agentTabs.cjs).
// Pure helpers: the store keeps the map, BrowserPanel and the tab strip read it. Nothing here depends
// on which harness drives the tab.
import type { AgentTabView, PaneLayer } from './native';
import type { AgentTabsMap } from '../../shared/model/window';
export type { AgentTabsMap } from '../../shared/model/window';

/** The map with one chat's tabs replaced (a chat with no tabs left drops out). */
export function withAgentTabs(map: AgentTabsMap, chatId: string, tabs: AgentTabView[]): AgentTabsMap {
  if (tabs.length) return { ...map, [chatId]: tabs };
  if (!(chatId in map)) return map;
  const { [chatId]: _gone, ...rest } = map;
  return rest;
}

/** The view of the pane tab for `chatId`'s browser tab `tabKey` (null: the chat's original tab), or null. */
export function agentTabFor(
  map: AgentTabsMap | undefined,
  chatId: string | undefined,
  tabKey: string | null | undefined,
): AgentTabView | null {
  if (!map || !chatId) return null;
  return map[chatId]?.find((t) => t.tabKey === (tabKey || null)) ?? null;
}

/** A chat's agent tabs and the key main reported them under: the chat's id, or the native session behind it. */
export function chatAgentTabs(
  map: AgentTabsMap,
  chatId: string,
  chatOf: (id: string) => string,
): { key: string; tabs: AgentTabView[] } | null {
  const key = chatId in map ? chatId : Object.keys(map).find((k) => chatOf(k) === chatId);
  return key ? { key, tabs: map[key] } : null;
}

/** The chats whose agents are using one of these pane tabs right now (the pane was hidden on them). */
export function agentChatsUsing(
  paneTabs: { kind: string; agentChat?: string; agentTab?: string }[],
  map: AgentTabsMap | undefined,
): string[] {
  const out = new Set<string>();
  for (const t of paneTabs) {
    if (t.kind !== 'browser' || !t.agentChat) continue;
    const v = agentTabFor(map, t.agentChat, t.agentTab ?? null);
    if (v?.active && !v.takenOver) out.add(t.agentChat);
  }
  return [...out];
}

type PaneTabLike = { id: string; kind: string; agentChat?: string; agentTab?: string; threadId?: string; ownerChat?: string };

/** The chats whose agent browser tabs a window's pane shows: the chat on screen and the side chats open in its pane. */
export function viewChats(routeChat: string | null, paneTabs: PaneTabLike[]): Set<string> {
  const out = new Set<string>(routeChat ? [routeChat] : []);
  for (const t of paneTabs) if (t.kind === 'chat' && t.threadId) out.add(t.threadId);
  return out;
}

/**
 * Whether a pane tab belongs in a view: an agent's browser tab, a chat's Background tasks tab and the tabs a chat's user
 * opened (`ownerChat`) only in that chat's view (a chat never sees another chat's tabs), every other tab in every view. `chatOf` maps a native session to its chat.
 */
export function inView(
  tab: Pick<PaneTabLike, 'kind' | 'agentChat' | 'threadId' | 'ownerChat'>,
  chats: Set<string>,
  chatOf: (id: string) => string,
): boolean {
  // the Background tasks tab lists one chat's tasks, so only that chat's view has it
  if (tab.kind === 'tasks') return !!tab.threadId && (chats.has(tab.threadId) || chats.has(chatOf(tab.threadId)));
  const owner = tab.kind === 'browser' && tab.agentChat ? tab.agentChat : tab.ownerChat;
  return !owner || chats.has(owner) || chats.has(chatOf(owner));
}

/** The tabs a view's tab strip lists, in order: what its menu's Close other tabs and Close tabs to the right count. */
export function shownTabs<T extends PaneTabLike>(tabs: T[], chats: Set<string>, chatOf: (id: string) => string): T[] {
  return tabs.filter((t) => inView(t, chats, chatOf));
}

/** The tab the pane shows in front: the active tab when it is in view, else the last tab in view ('' for none). */
export function frontTab(tabs: PaneTabLike[], active: string, chats: Set<string>, chatOf: (id: string) => string): string {
  const shown = shownTabs(tabs, chats, chatOf);
  return shown.some((t) => t.id === active) ? active : (shown.at(-1)?.id ?? '');
}

/**
 * How the pane lays out a tab's body: in front, painted behind the pane ('back': an agent is driving a
 * browser tab the pane doesn't show, and its input and screenshots need the page painted), or not at all.
 */
export function paneLayer(tab: PaneTabLike, front: string, map: AgentTabsMap | undefined): PaneLayer {
  if (tab.id === front) return 'front';
  if (tab.kind !== 'browser' || !tab.agentChat) return 'none';
  const v = agentTabFor(map, tab.agentChat, tab.agentTab ?? null);
  return v?.active && !v.takenOver ? 'back' : 'none';
}

/** The site permission as the agent bar says it, with a longer explanation for its tooltip. */
export function accessLabel(access: AgentTabView['access']): { label: string; detail: string } | null {
  switch (access) {
    case 'full':
      return { label: 'Full access', detail: 'This chat has Full access: the agent can use any site without asking.' };
    case 'write':
      return { label: 'Can read and act', detail: 'You allowed this site: the agent can read the page, click and type.' };
    case 'read':
      return { label: 'Read only', detail: 'You allowed this site read only: the agent can read the page but not click or type.' };
    case 'denied':
      return { label: 'Not allowed', detail: 'You did not allow this site in this chat.' };
    case 'ask':
      return { label: 'Asks first', detail: 'The agent asks you before it uses this site.' };
    default:
      return null;
  }
}

/** What the tab strip says about a tab an agent opened or kept, or null for an ordinary tab. */
export function agentTabBadge(v: AgentTabView | null): string | null {
  if (!v) return null;
  if (v.mark === 'handoff') return 'Opened by the agent for you to continue';
  if (v.mark === 'deliverable') return 'Opened by the agent to show you a result';
  if (v.result) return 'Where the agent finished (stays open)';
  if (v.created) return 'Opened by the agent (closes when its turn ends)';
  return null;
}

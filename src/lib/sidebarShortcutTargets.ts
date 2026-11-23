// The rendered sidebar order shared by numbered navigation and its shortcut hints, including duplicate and collapsed rows.
export type Target = { row: HTMLElement; id: string; action: string };
export const SIDEBAR = '.thread-sidebar:not(.leaving):not(.drag-hidden)';

/** Include displayed rows in DOM order, once per chat; closing disclosures retire their rows immediately. */
export function sidebarShortcutTargets(sidebar: HTMLElement): Target[] {
  const chats = new Set<string>();
  const recents = new Set<string>();
  const targets: Target[] = [];
  for (const row of sidebar.querySelectorAll<HTMLElement>('[data-sidebar-chat]')) {
    const id = row.dataset.sidebarChat!;
    if (!id || row.closest('.collapse:not(.open), [hidden], [inert]')) continue;
    if (!chats.has(id)) {
      chats.add(id);
      if (chats.size <= 9) targets.push({ row, id, action: `chat-${chats.size}` });
    }
    if (row.closest('[data-shortcut-recents]') && !recents.has(id)) {
      recents.add(id);
      if (recents.size <= 6) targets.push({ row, id, action: `recent-${recents.size}` });
    }
  }
  return targets;
}

/** The native menu, renderer and browser-forwarded commands all use the same currently displayed target. */
export function numberedSidebarChat(action: string, fallback: () => string[]): string | undefined {
  const sidebar = document.querySelector<HTMLElement>(SIDEBAR);
  return sidebar ? sidebarShortcutTargets(sidebar).find((t) => t.action === action)?.id : fallback()[Number(action.at(-1)) - 1];
}

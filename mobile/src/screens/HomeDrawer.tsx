// What the drawer behind Chats lists: Chats, MoMo and Scheduled, then the pinned chats and the recent ones, your initials (Settings) and New chat.
import type { ChatListItem } from '../components/ChatRow';
import { useChatSearch } from '../components/ChatSearch';
import { DrawerPanel, type DrawerDestination } from '../components/Drawer';
import { Icon } from '../components/Icon';
import { Spark } from '../components/Spark';
import { chatChips } from '../presentation/chatChips';
import { initialsOf, sessionState } from '../presentation/sessionState';
import { useTheme } from '../theme';

/** How many recent chats the drawer lists; the Chats page has the rest. */
export const DRAWER_RECENTS = 12;

/**
 * Every action closes the drawer first, as Claude's does, so the page it opens slides in over Chats. An action that is
 * absent is not offered: MoMo for an account without it, Scheduled and New chat while the computer is away, a chat while
 * it cannot be opened.
 */
export function HomeDrawerPanel({
  user,
  chats,
  offline,
  leave,
  openChat,
  momo,
  scheduled,
  settings,
  newChat,
}: {
  user: { name?: string; email?: string };
  chats: ChatListItem[] | null;
  offline: boolean;
  /** Closes the drawer; every action calls it first. */
  leave: () => void;
  openChat?: (id: string) => void;
  momo?: () => void;
  scheduled?: () => void;
  settings: () => void;
  newChat?: () => void;
}) {
  const theme = useTheme();
  const search = useChatSearch();
  const then = (fn: () => void) => () => {
    leave();
    fn();
  };
  const destinations: DrawerDestination[] = [
    { key: 'chats', title: 'Chats', icon: <Icon name="bubble.left" glyph="▢" size={20} color={theme.ink} />, onPress: leave },
  ];
  if (momo) destinations.push({ key: 'momo', title: 'MoMo', icon: <Spark size={22} />, onPress: then(momo) });
  if (scheduled)
    destinations.push({
      key: 'scheduled',
      title: 'Scheduled',
      icon: <Icon name="clock" glyph="◷" size={20} color={theme.ink} />,
      onPress: then(scheduled),
    });
  const now = Date.now();
  // sub-sessions stay under their parent on the Chats page; the drawer lists the chats you started
  const top = (chats ?? []).filter((chat) => !chat.parentId);
  const row = (chat: ChatListItem) => ({
    id: chat.id,
    title: chat.title || 'Untitled chat',
    state: sessionState(chatChips(chat, now, offline).state),
  });
  return (
    <DrawerPanel
      destinations={destinations}
      current="chats"
      pinned={top.filter((chat) => chat.pinned).map(row)}
      recents={top
        .filter((chat) => !chat.pinned)
        .slice(0, DRAWER_RECENTS)
        .map(row)}
      openChat={(id) => {
        leave();
        openChat?.(id);
      }}
      initials={initialsOf(user)}
      settings={then(settings)}
      newChat={newChat && then(newChat)}
      // as in Claude's drawer header: search the chats, on the list the drawer slides back to
      search={search.listed ? then(search.show) : undefined}
    />
  );
}

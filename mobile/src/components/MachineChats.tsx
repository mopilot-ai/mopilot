// A machine page's Chats section (#4603): the chats the Mac has listed on that machine, newest first, each opening as a chat (through the machine itself while the Mac is away).
import { Group, GroupItem, GroupLabel } from './Grouped';
import type { StartedChat } from '../remote/hostChat';
import type { ChatListItem } from './ChatRow';

/** How many chats the page lists: the newest ones; the rest are on Home. */
export const MACHINE_CHATS_SHOWN = 20;

/**
 * The chats that run on a machine, newest first: the Mac's list (null while it has none) and the chats this phone started there itself, which
 * the Mac has not listed yet (the Mac's own row of a chat is the one that stands).
 */
export const chatsOn = (chats: ChatListItem[] | null | undefined, machineId: string, started: StartedChat[] = []) =>
  [
    ...(chats ?? []),
    ...started
      .filter((c) => !chats?.some((m) => m.id === c.chatId))
      .map((c): ChatListItem => ({ id: c.chatId, title: c.title, state: 'idle', hostId: c.machineId, at: c.at })),
  ]
    .filter((c) => c.hostId === machineId)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MACHINE_CHATS_SHOWN);

export function MachineChats({ chats, open }: { chats: ChatListItem[]; open: (chatId: string) => void }) {
  if (!chats.length) return null;
  return (
    <>
      <GroupLabel>Chats</GroupLabel>
      <Group>
        {chats.map((c) => (
          <GroupItem
            key={c.id}
            title={c.title?.trim() || 'Untitled chat'}
            detail={c.state === 'waiting' ? 'Needs input' : (c.project ?? undefined)}
            end="chevron"
            onPress={() => open(c.id)}
          />
        ))}
      </Group>
    </>
  );
}

// Keeps the Needs-you review going from chat to chat: the waiting chats in the order the list shows them, the one open now, and what follows it.
import type { MobileRuntime } from '../contracts';
import { harnessChip } from '../presentation/chatChips';
import type { ChatListItem } from './ChatRow';
import { ReviewSheet } from './ReviewSheet';

export function ReviewHost({
  runtime,
  chats,
  id,
  go,
  openChat,
  askChanges,
  done,
}: {
  runtime: MobileRuntime;
  chats: ChatListItem[];
  /** The chat under review. */
  id: string;
  /** Moves the review to another chat, or ends it with null. */
  go: (id: string | null) => void;
  openChat: (id: string) => void;
  /** Opens the chat to ask what should change in the plan card of that key. */
  askChanges: (id: string, card: string) => void;
  /** The review ended: the list is read again, as the answers moved some chats out of Needs you. */
  done: () => void;
}) {
  const waiting = chats.filter((chat) => chat.state === 'waiting');
  const at = waiting.findIndex((chat) => chat.id === id);
  const chat = chats.find((item) => item.id === id);
  const following = at >= 0 ? waiting[at + 1] : undefined;
  return (
    <ReviewSheet
      key={id}
      runtime={runtime}
      chatId={id}
      title={chat?.title || 'Untitled chat'}
      subtitle={[harnessChip(chat?.harness), chat?.project].filter(Boolean).join(' · ') || undefined}
      position={at >= 0 && waiting.length > 1 ? `${at + 1} of ${waiting.length}` : undefined}
      next={following ? () => go(following.id) : undefined}
      openChat={() => {
        go(null);
        openChat(id);
      }}
      askChanges={(card) => {
        go(null);
        askChanges(id, card);
      }}
      close={() => {
        go(null);
        done();
      }}
    />
  );
}

// The rows a chat last showed (its cache), drawn while its computer is away: the same bubbles, your queued sends in their places.
import { withPendingRows } from '../presentation/thread';
import { MessageBubble } from './MessageBubble';
import { SentBubble } from './SentBubble';

type Rows = Parameters<typeof withPendingRows>;

export function CachedRows({ shown, waiting }: { shown: Rows[0]; waiting: Rows[1] }) {
  return withPendingRows(shown, waiting).map((r) =>
    r.optimistic ? (
      <SentBubble key={r.key} id={r.key} text={r.text} pictures={r.pictures} />
    ) : (
      <MessageBubble key={r.key} id={r.key} role={r.role} text={r.text} />
    ),
  );
}

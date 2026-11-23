// What you sent that MoMo's chat does not record yet, under its rows: sent lines kept until recorded, what the Mac holds for the running turn, and the outbox's own.
import { HELD_LINE, WAITING_LINE } from '../components/MacQueue';
import { QueuedMessages } from '../components/QueuedMessages';
import { SentBubble } from '../components/SentBubble';
import type { QueuedSend } from '../outbox';
import type { Sent } from '../presentation/sentMessages';

export function MomoPending({
  waiting,
  held,
  queued,
  turnOpen,
  calls,
}: {
  /** sends the Mac took whose record is not in the chat yet */
  waiting: Sent[];
  /** the Mac's queue for the running turn, read-only */
  held: QueuedSend[];
  /** the outbox's sends */
  queued: QueuedSend[];
  turnOpen: boolean;
  calls: {
    cancel: (id: string) => void;
    retry: (id: string) => void;
    edit: (id: string, text: string) => boolean;
  };
}) {
  return (
    <>
      {waiting.map((s) => (
        <SentBubble key={`sent:${s.id}`} id={`sent:${s.id}`} text={s.text} />
      ))}
      {held.length > 0 && (
        <QueuedMessages items={held} queuedLine={turnOpen ? WAITING_LINE : HELD_LINE} readOnly rises={false} pins={false} {...calls} />
      )}
      {queued.length > 0 && <QueuedMessages pins={false} items={queued} {...calls} />}
    </>
  );
}

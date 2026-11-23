// The open chat as the app's stack draws it: the chat screen with the messages the phone holds for this chat, read from the outbox here so a message queued, sent or accepted draws the chat and not the app root or the home under it (#4986), and the one question about notifications, asked at the end of a reply.
import { type ComponentProps, useMemo } from 'react';
import { useOutbox } from '../outboxView';
import { NotificationsCard } from '../push/NotificationsCard';
import type { PushController, PushUi } from '../push/controller';
import { Thread } from './Thread';

type ThreadProps = ComponentProps<typeof Thread>;

/** `pair` is the computer the chat is on (the selected one, or the last one while it is away). */
export function ChatRoute({
  pair,
  push,
  pushUi,
  ...thread
}: Omit<ThreadProps, 'queued' | 'notify'> & { pair: string | null | undefined; push?: PushController; pushUi?: PushUi }) {
  const outbox = useOutbox(thread.runtime);
  const queued = useMemo(
    () => outbox.filter((item) => item.chatId === thread.chatId && item.pairId === pair),
    [outbox, thread.chatId, pair],
  );
  // asked once a reply has finished, when a notification can mean something; "Not now" is remembered, and a refusal in the system's settings is Settings' to say
  const ask = push && pushUi?.step === 'explain' ? <NotificationsCard push={push} step={pushUi.step} busy={pushUi.busy} /> : undefined;
  return <Thread {...thread} queued={queued} notify={ask} />;
}

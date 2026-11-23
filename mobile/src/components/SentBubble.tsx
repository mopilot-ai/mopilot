// Your message as it sits in the chat from the tap on, before the computer's record of it: the pending copy that takes the outbox bubble's place (or is the first bubble, when nothing was queued) and reports where it sits so the list can pin it.
import { MessageBubble } from './MessageBubble';
import { RiseIn } from './RiseIn';
import { reportSentTop } from '../sendOrigin';

/** Replace the body with the sent-message enter motion; it leaves without a fade because the computer's copy is drawn in the same frame. */
export function SentBubble({ id, text, pictures }: { id: string; text: string; pictures?: string[] }) {
  return (
    <RiseIn onLayout={(event) => reportSentTop(event.nativeEvent.layout.y)}>
      <MessageBubble id={id} role="user" text={text} pictures={pictures} />
    </RiseIn>
  );
}

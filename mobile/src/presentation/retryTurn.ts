// The turn's "Try again": the chat's last message goes once more as a new send, shown as sent at once; a send that goes takes back the page's error line, one that is refused puts its words there.
import type { Dispatch, SetStateAction } from 'react';
import type { MobileRuntime } from '../contracts';
import { withSent, type RowLike, type Sent } from './sentMessages';

/**
 * @param o.runtime the phone's runtime @param o.chatId the chat @param o.text the message to send again
 * @param o.setSent the page's sends not yet recorded @param o.rows what the page shows now (read when the send happens)
 * @param o.held the messages the Mac already holds, so the new one is told apart @param o.pin keeps the new message in view
 * @param o.setError the page's one error line
 */
export function retryTurn(o: {
  runtime: Pick<MobileRuntime, 'send'>;
  chatId: string;
  text: string;
  setSent: Dispatch<SetStateAction<Sent[]>>;
  rows: () => RowLike[];
  held: { id: string }[];
  pin: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return () => {
    try {
      const id = o.runtime.send(o.chatId, o.text, [], []);
      o.setSent((old) =>
        withSent(
          old,
          o.rows(),
          o.text,
          id,
          o.held.map((h) => h.id),
        ),
      );
      o.pin();
      o.setError(null);
    } catch (e: unknown) {
      o.setError(e instanceof Error ? e.message : String(e));
    }
  };
}

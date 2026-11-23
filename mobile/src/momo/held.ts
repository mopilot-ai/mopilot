// MoMo's messages the Mac holds for a running turn, as bubbles under the chat: shown from the Mac's queue once the outbox let go, never twice.
import type { QueuedSend } from '../outbox';
import { heldOf } from '../components/MacQueue';

/** The Mac's queued messages of the user that the outbox does not still show; a message the outbox holds is matched by its words, one for one. */
export function heldItems(session: Record<string, unknown> | undefined, outbox: { text: string }[], chatId: string): QueuedSend[] {
  const left = outbox.map((o) => o.text.trim());
  return heldOf(session)
    .filter((h) => {
      const at = left.indexOf(h.text.trim());
      if (at < 0) return true;
      left.splice(at, 1);
      return false;
    })
    .map((h) => ({ id: h.id, pairId: '', chatId, text: h.text, attachments: [], at: 0, status: 'queued' as const, error: null }));
}

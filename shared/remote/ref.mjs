// The opaque chat handle a push request carries: the relay sees it, only a device that knows the chat id can recompute it.
import { createHash } from 'node:crypto';

/** The handle of `chatId` on one pair: 22 base64url characters of SHA-256 over the pair id and the chat id. */
export function chatRef(pairId, chatId) {
  return createHash('sha256').update(`${pairId}\n${chatId}`).digest('base64url').slice(0, 22);
}

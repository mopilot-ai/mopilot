// Native message correlation is negotiated per paired computer; stale hello replies cannot enable a retired owner, and legacy computers keep text-only fallback behavior.
import { messageIdentity } from '../../../shared/remote/messageIdentity.mjs';
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
export const IMAGE_UPDATE = 'Update MoPilot on this computer to send pictures. Your attachment is kept.';
export function createMessageIdentity(hash: (bytes: Uint8Array) => Uint8Array, pair: () => string | null) {
  const supported = new Map<string, boolean>();
  return {
    supports: (pairId = pair()) => !!pairId && supported.get(pairId) === true,
    observe(pairId: string, answer: Promise<unknown>, current: () => boolean) {
      void answer.then(
        (reply) => {
          if (current()) supported.set(pairId, rec(rec(reply).capabilities).messageIdentity === 1);
        },
        () => undefined,
      );
    },
    id(method: 'chat.send' | 'chat.start', chatId: string | null, id: string, pairId = pair()) {
      return pairId && supported.get(pairId) === true ? messageIdentity(hash, pairId, method, chatId, id) : undefined;
    },
  };
}

// Serialize follow and unfollow requests so a retired view cannot unsubscribe its replacement.
import type { MobileRuntime } from '../contracts';
/** Rows asked for when a chat opens: the last page only, so an open costs the same however long the chat is. */
export const FOLLOW_ROWS = 30;
const tails = new WeakMap<MobileRuntime, Map<string, Promise<unknown>>>();
/** `rows`: how many of the chat's last rows a follow asks for (a read again of a chat paged back asks for what is on screen). */
export function followRequest(
  runtime: MobileRuntime,
  chatId: string,
  method: 'chat.follow' | 'chat.unfollow',
  rows = FOLLOW_ROWS,
): Promise<unknown> {
  let chats = tails.get(runtime);
  if (!chats) {
    chats = new Map();
    tails.set(runtime, chats);
  }
  const queue = chats;
  const owner = runtime.snapshot();
  const send = () => {
    if (runtime.snapshot().selectedPair !== owner.selectedPair || runtime.snapshot().generation !== owner.generation)
      throw new Error('The connected computer changed. Try again.');
    return runtime.request(method, method === 'chat.follow' ? { chatId, items: rows } : { chatId });
  };
  const tail = queue.get(chatId);
  // nothing ahead of it: the request leaves in this call, not a tick later, so it is first on the wire
  let result: Promise<unknown>;
  if (tail) {
    result = tail
      .catch(() => {
        /* Continue the queue after a refused request. */
      })
      .then(send);
  } else {
    try {
      result = Promise.resolve(send());
    } catch (error) {
      result = Promise.reject(error);
    }
  }
  queue.set(chatId, result);
  void result.then(
    () => {
      if (queue.get(chatId) === result) queue.delete(chatId);
    },
    () => {
      if (queue.get(chatId) === result) queue.delete(chatId);
    },
  );
  return result;
}

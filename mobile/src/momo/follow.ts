// Serialize MoMo follow and unfollow requests so a retired view cannot unsubscribe its replacement.
import type { MobileRuntime } from '../contracts';

const tails = new WeakMap<MobileRuntime, Promise<unknown>>();

export function momoFollow(
  runtime: MobileRuntime,
  method: 'momo.chat.follow' | 'momo.chat.unfollow',
  /** a channel's journal (A2); left out, MoMo's main chat */
  channelId: string | null = null,
): Promise<unknown> {
  const owner = runtime.snapshot();
  const result = (tails.get(runtime) ?? Promise.resolve())
    .catch(() => {
      /* Continue the queue after a refused request. */
    })
    .then(() => {
      const now = runtime.snapshot();
      if (now.selectedPair !== owner.selectedPair || now.generation !== owner.generation)
        throw new Error('The connected computer changed. Try again.');
      const channel = channelId ? { channelId } : {};
      return runtime.request(method, method === 'momo.chat.follow' ? { items: 50, ...channel } : channel);
    });
  tails.set(runtime, result);
  return result;
}

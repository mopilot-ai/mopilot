// MoMo's main chat followed once for the whole tab: the snapshot, live events, and retryable actions on it.
import { useEffect, useRef, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { messageOf } from './api';
import { momoFollow } from './follow';
import { useCatchUpWhenBack } from '../catchUp';
import { createFollowFeed } from '../presentation/followFeed';
import type { Data, Thread } from '../presentation/thread';

/** MoMo's main chat, followed while `enabled`; the Mac picks the chat and names it in the snapshot, so only its events count. */
export function useFollowedChat(runtime: MobileRuntime, enabled: boolean, channelId: string | null = null) {
  // the thread read, with the channel it was read for: after the phone switched chats, the old chat's thread is not the new chat's
  const [read, setRead] = useState<{ thread: Thread; channel: string | null } | null>(null);
  const thread = read && read.channel === channelId ? read.thread : null;
  useCatchUpWhenBack(!enabled);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<() => void>(() => () => undefined);
  useEffect(() => {
    setRead(null);
    setError(null);
    if (!enabled) return;
    let chatId: string | null = null;
    const feed = createFollowFeed({
      read: async () => {
        const result = await momoFollow(runtime, 'momo.chat.follow', channelId);
        const named = (result as { chatId?: unknown } | null)?.chatId;
        if (typeof named !== 'string' || !named) throw new Error("Couldn't read MoMo's chat. Try again.");
        chatId = named;
        return result;
      },
      subscribe: (handle) =>
        runtime.onEvent((event) => {
          if (typeof event.chatId === 'string') handle(event as Data);
        }),
      // before the snapshot names the chat every event is held; after it, only that chat's
      accepts: (event) => chatId === null || event.chatId === chatId,
      on: {
        thread: (value) => {
          setError(null);
          setRead({ thread: value, channel: channelId });
        },
        failed: (message) => setError(messageOf(message)),
      },
    });
    setRefresh(() => feed.refresh);
    feed.start();
    return () => {
      feed.stop();
      void momoFollow(runtime, 'momo.chat.unfollow', channelId).catch(() => {
        /* Cleanup is best effort after the view is retired. */
      });
    };
  }, [runtime, enabled, channelId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // a reload reads the chat again in place, keeping what is shown
  return { thread, error, reload: refresh, mounted };
}

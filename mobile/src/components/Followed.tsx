// Follows a chat for the lifetime of its children: the Mac refuses a device's review, terminal and live-view requests unless it follows the chat.
import { type ReactNode, useEffect } from 'react';
import type { MobileRuntime } from '../contracts';
import { followRequest } from '../presentation/follow';
import { Loadable } from './Loadable';

export function Followed({ runtime, chatId, children }: { runtime: MobileRuntime; chatId: string; children: ReactNode }) {
  useEffect(
    () => () => {
      void followRequest(runtime, chatId, 'chat.unfollow').catch(() => {
        /* Cleanup is best effort after the view is retired. */
      });
    },
    [runtime, chatId],
  );
  return (
    <Loadable what="chat" load={() => followRequest(runtime, chatId, 'chat.follow')}>
      {() => children}
    </Loadable>
  );
}

// What a chat's transcript is drawn inside: the chat whose activity its marks follow, and, for a chat on a machine, that machine's folder, so the links in it open files there instead of on this Mac (#4062).
import type { ReactNode } from 'react';
import { useRemoteFolderValue } from '../../lib/chatMachine';
import { RemoteFolderContext } from '../../lib/remoteFolder';
import { useStore } from '../../store/core';
import { ActivityChat } from './turnTokens';

export function ChatScope({ threadId, children }: { threadId: string; children: ReactNode }) {
  const remote = useRemoteFolderValue(
    threadId,
    useStore((s) => s.threads[threadId]?.cwd ?? ''),
  );
  return (
    <ActivityChat.Provider value={threadId}>
      <RemoteFolderContext.Provider value={remote}>{children}</RemoteFolderContext.Provider>
    </ActivityChat.Provider>
  );
}

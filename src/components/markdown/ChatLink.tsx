// A link to another MoPilot chat that opens it in this window, by the chat's title (or its linked-session handle, the link's own words, or its id while the window doesn't know it yet): in linked-session cards and in messages, where an agent writes one as [title](mopilot:chat/<id>).
import type { ReactNode } from 'react';
import { threadTitle, useStore } from '../../store/core';
import { openChatFrom } from '../../session/openChat';
import { useChatName } from './useChatName';

export { useChatName };

export function ChatLink({ id, className = 'peer-chat-link', children }: { id: string; className?: string; children?: ReactNode }) {
  const title = useStore((st) => (st.threads[id] ? threadTitle(st.threads[id]) : null));
  const name = useChatName(id);
  return (
    // Conversation links stay in this window; ⌥-click opens a split (src/session/openChat.ts).
    <button type="button" className={className} onClick={(e) => openChatFrom(e, id, { newWindow: false })}>
      {title || children || name || id}
    </button>
  );
}

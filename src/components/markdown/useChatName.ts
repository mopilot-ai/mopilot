// A chat's name as links and linked-session rows read it, without the link that opens it (components/markdown/ChatLink.tsx).
import { threadTitle, useStore } from '../../store/core';
import { useOrchestration } from '../../lib/sideSessions';

/** A chat's name: its title, else its linked-session handle; null while the window knows neither, or `id` is empty. */
export function useChatName(id: string): string | null {
  const title = useStore((st) => (id && st.threads[id] ? threadTitle(st.threads[id]) : null));
  const name = useOrchestration().children[id]?.name;
  return title || name || null;
}

// New-chat submissions shown in the sidebar while their folder and native session are still being prepared.
import { create } from 'zustand';
import { provisionalTitle } from '../../shared/title.mjs';

export interface ChatStart {
  id: string;
  name: string;
  cwd: string;
  projectId: string | null;
  /** the machine the chat starts on, when it is not this Mac: `cwd` is that machine's folder */
  hostId?: string;
  updatedAt: number;
}

/** Transient presentation only: these ids never enter the native chat list, persistence or chat actions. */
export const useChatStarts = create<ChatStart[]>(() => []);

/** Independent submissions keep independent entries, including when an older startup finishes last. */
export function showChatStart(seed: string, target: Pick<ChatStart, 'cwd' | 'projectId' | 'hostId'>): () => void {
  const entry: ChatStart = { ...target, id: crypto.randomUUID(), name: provisionalTitle(seed) || 'New chat', updatedAt: Date.now() / 1000 };
  useChatStarts.setState((entries) => [entry, ...entries], true);
  return () => useChatStarts.setState((entries) => entries.filter((e) => e.id !== entry.id), true);
}

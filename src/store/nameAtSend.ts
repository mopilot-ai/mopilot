// A new chat's provisional title, shown the moment its first message is sent on any harness: the title its harness
// writes replaces it (each harness's threadName event), and a message that didn't go takes it back.
import { provisionalTitle } from '../../shared/title.mjs';
import { get, set } from './core';

/** Called only for a chat in the list, read just before in the same task. */
const named = (chatId: string, name: string | null) =>
  set((st) => ({ threads: { ...st.threads, [chatId]: { ...st.threads[chatId], name } } }));

/** Names a new chat after its first words now; returns what takes that name back while it is still the chat's name. */
export function nameAtSend(chatId: string, text: string): () => void {
  const t = get().threads[chatId];
  const name = provisionalTitle(text);
  // a temporary chat is never named, and a chat with a name keeps it
  if (!t || t.name || t.ephemeral || !name) return () => undefined;
  named(chatId, name);
  return () => {
    if (get().threads[chatId]?.name === name) named(chatId, null);
  };
}

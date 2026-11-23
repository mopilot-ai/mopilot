// A chat archived or restored elsewhere (another window, or main archiving inactive chats with no window open, #1367):
// this window's sidebar and Archived chats follow, as they do for an archive made here.
import type { ChatView } from '../lib/chatMeta';
import { nativeFamily, type HarnessFamily } from '../harness/family';
import { noteIgnored } from '../lib/ignored';
import { get, set, upsertThread } from './core';
import { loadThreads } from './connection';
import { retireChatFromView } from './splitView';
import { runtime } from './runtime';

/** A restored chat this window had no row for comes back with its harness's chat list. */
const RELOAD: Record<HarnessFamily, () => Promise<unknown> | unknown> = {
  codex: () => loadThreads(),
  claude: () => runtime().loadClaudeThreads(),
  acp: () => runtime().loadAcpThreads(),
};

/** Call with main's view of the chat before it is applied: compares it with what this window knew. */
export function followArchive(id: string, chat: ChatView | null) {
  const was = typeof get().claudeArchived[id] === 'number';
  const now = typeof chat?.meta?.archived === 'number';
  if (now && !was) {
    const t = get().threads[id];
    // the archived list shows it after it leaves the sidebar
    runtime().rememberClaudeThread(t);
    set((s) => {
      const { [id]: _t, ...threads } = s.threads;
      return {
        threads,
        threadOrder: s.threadOrder.filter((x) => x !== id),
        archived: t ? [t, ...s.archived.filter((a) => a.id !== id)] : s.archived,
      };
    });
    retireChatFromView(id);
  } else if (was && !now && chat) {
    // restored (a deleted chat, null, leaves through its deletion receipt)
    const t = get().archived.find((a) => a.id === id);
    set((s) => ({ archived: s.archived.filter((a) => a.id !== id) }));
    if (t) upsertThread(t);
    else
      Promise.resolve()
        .then(RELOAD[nativeFamily(id)])
        .catch((error) => noteIgnored('list a chat restored in another window', error));
  }
}

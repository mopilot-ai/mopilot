// Which chat is open, and the parents under it when it was opened from a parent's sub-session card (and the plan whose changes it was opened to ask for); plus the title and line a chat's bar shows.
import { useMemo, useState } from 'react';
import { harnessChip } from './presentation/chatChips';

type Listed = { id: string; title?: string; harness?: unknown; project?: string | null; parentId?: string; pinned?: boolean };

export function useChatTrail() {
  // one state, updated from its last value: two pops in one go (a long press on Back) land two levels down
  const [{ chat, trail, ask }, set] = useState<{ chat: string | null; trail: string[]; ask: string | null }>({
    chat: null,
    trail: [],
    ask: null,
  });
  // the moves never change, so effects that call them need not run again
  const moves = useMemo(
    () => ({
      /** Closed outright (the chat went away): no parent to return to either. */
      clear: () => set({ chat: null, trail: [], ask: null }),
      /** Opened from anywhere but a parent chat: a new trail. `ask`: the key of the plan card the quick review's "Ask for changes" was tapped on, so the chat asks what should change in that plan. */
      show: (id: string, ask: string | null = null) => set({ chat: id, trail: [], ask }),
      /** A linked chat: keep one screen per chat, returning to its source (including a quick-review plan). */
      push: (id: string, source?: string) =>
        set((old) => {
          const current = source ?? old.chat;
          const trail = source && source !== old.chat ? [] : old.trail;
          if (id === current) return { chat: id, trail, ask: null };
          const at = trail.indexOf(id);
          return { chat: id, trail: at >= 0 ? trail.slice(0, at) : current ? [...trail, current] : trail, ask: null };
        }),
      /** Back: to the parent it was opened from, else to the list. */
      pop: () => set((old) => ({ chat: old.trail.at(-1) ?? null, trail: old.trail.slice(0, -1), ask: null })),
    }),
    [],
  );
  return { chat, trail, ask, ...moves };
}

/** The open chat's bar: its title, and under it the chat that started it, else its agent and project. */
export function chatHeading(chats: readonly Listed[] | null | undefined, id: string | null) {
  const item = id ? chats?.find((c) => c.id === id) : undefined;
  const parent = item?.parentId ? chats?.find((c) => c.id === item.parentId) : undefined;
  const line = item ? [harnessChip(item.harness), item.project].filter(Boolean).join(' · ') || undefined : undefined;
  return { title: item?.title || undefined, subtitle: parent ? `Sub-session of ${parent.title || 'Untitled chat'}` : line };
}

/** All the open chat's header needs from the list: its heading, whether it is pinned, and what Back returns to. */
export function chatHeader(chats: readonly Listed[] | null | undefined, id: string | null, trail: readonly string[]) {
  const parent = trail.at(-1);
  return {
    ...chatHeading(chats, id),
    pinned: !!id && chats?.find((c) => c.id === id)?.pinned === true,
    backLabel: parent ? `Back to ${chatHeading(chats, parent).title ?? 'the chat'}` : undefined,
  };
}

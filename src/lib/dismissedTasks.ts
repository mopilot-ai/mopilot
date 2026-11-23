// Finished tasks the user cleared from a chat's Background tasks tab, kept per chat in localStorage (100 chats x 1000 ids).
import { useSyncExternalStore } from 'react';

const KEY = 'mopilot.dismissedTasks';
const MAX_CHATS = 100;
const MAX_IDS = 1000;
const NONE: ReadonlySet<string> = new Set();

let chats: Map<string, string[]> | null = null;
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

function load(): Map<string, string[]> {
  if (chats) return chats;
  chats = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const [chat, ids] of Object.entries(saved))
      if (Array.isArray(ids))
        chats.set(
          chat,
          ids.filter((id): id is string => typeof id === 'string'),
        );
  } catch (e) {
    // unreadable or blocked storage: start empty
    console.warn('Could not read the cleared tasks', e);
  }
  return chats;
}

function put(chatId: string, ids: string[]) {
  const m = load();
  m.delete(chatId);
  if (ids.length) m.set(chatId, ids.slice(-MAX_IDS));
  // the chats cleared longest ago go first
  for (const old of m.keys()) {
    if (m.size <= MAX_CHATS) break;
    m.delete(old);
    sets.delete(old);
  }
  sets.delete(chatId);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m)));
  } catch (e) {
    // storage full or blocked: the ids still hold for this window
    console.warn('Could not save the cleared tasks', e);
  }
  listeners.forEach((l) => l());
}

/** Hide these finished tasks from the chat's tab. */
export function dismissTasks(chatId: string, ids: string[]) {
  const cur = load().get(chatId) ?? [];
  put(chatId, [...new Set([...cur, ...ids])]);
}

/** Show these tasks again (a dismissed task that runs again). */
export function undismissTasks(chatId: string, ids: string[]) {
  const drop = new Set(ids);
  put(
    chatId,
    (load().get(chatId) ?? []).filter((id) => !drop.has(id)),
  );
}

/** The chat's dismissed task ids. */
export function dismissedIds(chatId: string): ReadonlySet<string> {
  let s = sets.get(chatId);
  if (!s) {
    const ids = load().get(chatId);
    s = ids?.length ? new Set(ids) : NONE;
    sets.set(chatId, s);
  }
  return s;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Re-render when the chat's dismissed ids change. */
export function useDismissedIds(chatId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => dismissedIds(chatId));
}

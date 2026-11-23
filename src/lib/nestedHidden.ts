// Which chats' nested sessions the sidebar hides (sidebar/ChildRows.tsx), per sidebar view, kept across reloads and
// shared by this app's windows in localStorage (only hidden ones are stored; every chat starts with them shown).
import { useSyncExternalStore } from 'react';

const KEY = 'mopilot.nestedHidden';
const MAX = 500;

/** The sidebar list a row is in: a project's group, the one-list view, or Recents. */
export type NestedView = 'project' | 'list' | 'recents';

let hidden: string[] | null = null;
let watching = false;
const listeners = new Set<() => void>();

const keyOf = (view: NestedView, chatId: string) => `${view}:${chatId}`;

function read(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : [];
  } catch (e) {
    // unreadable or blocked storage: every chat's nested sessions show
    console.warn('Could not read which nested sessions are hidden', e);
    return [];
  }
}

function load(): string[] {
  hidden ??= read();
  return hidden;
}

function changed() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  if (!watching) {
    watching = true;
    // another window hid or showed some: follow it
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      hidden = read();
      changed();
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function nestedHidden(view: NestedView, chatId: string): boolean {
  return load().includes(keyOf(view, chatId));
}

/** Hide or show the nested sessions of each of `chatIds` in `view`. */
export function setNestedHidden(view: NestedView, chatIds: string[], hide: boolean) {
  const keys = chatIds.map((id) => keyOf(view, id));
  const rest = load().filter((k) => !keys.includes(k));
  hidden = hide ? [...rest, ...keys].slice(-MAX) : rest;
  changed();
  try {
    localStorage.setItem(KEY, JSON.stringify(hidden));
  } catch (e) {
    // storage full or blocked: it still holds for this window
    console.warn('Could not save which nested sessions are hidden', e);
  }
}

/** Whether the chat's nested sessions are hidden in `view`, kept current. */
export function useNestedHidden(view: NestedView, chatId: string): boolean {
  return useSyncExternalStore(subscribe, () => nestedHidden(view, chatId));
}

/** Every hidden chat's key, kept current: for a control over several chats. */
export function useNestedHiddenKeys(): readonly string[] {
  return useSyncExternalStore(subscribe, load);
}

/** Whether `keys` (useNestedHiddenKeys) hide the chat's nested sessions in `view`. */
export const hiddenIn = (keys: readonly string[], view: NestedView, chatId: string) => keys.includes(keyOf(view, chatId));

/** Tests: forget what was read. */
export function resetNestedHidden() {
  hidden = null;
}

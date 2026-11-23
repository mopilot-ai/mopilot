// A line the home asked to be said beside the result of a move the person made (an intent's `notice`), shown on the page until they dismiss it or another one replaces it.
import { useSyncExternalStore } from 'react';

let note: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Says `text` (null clears it). @param {string | null} text */
export function setHomeNotice(text: string | null) {
  if (note === text) return;
  note = text;
  emit();
}

/** The line to show, or null. */
export function useHomeNotice(): string | null {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => note,
  );
}

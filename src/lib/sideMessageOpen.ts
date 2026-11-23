// Which "Received message from …" rows the user opened (components/thread/ReceivedMessage.tsx), kept for the life of
// the window so a row that unmounts (the chat switched away and back, a scrolled-off row) comes back as it was left.
import { useCallback, useState, useSyncExternalStore } from 'react';

const opened = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Whether the row `key` (the delivery's key, plus the note's index inside a wake-up) is open, and how to change it.
 * Rows are closed until opened; one without a key keeps its choice in the row only.
 */
export function useMessageOpen(key: string | undefined): [boolean, (open: boolean) => void] {
  const [local, setLocal] = useState(false);
  const stored = useSyncExternalStore(
    subscribe,
    () => key !== undefined && opened.has(key),
    () => false,
  );
  const set = useCallback(
    (open: boolean) => {
      if (key === undefined) return setLocal(open);
      if (open) opened.add(key);
      else opened.delete(key);
      for (const fn of listeners) fn();
    },
    [key],
  );
  return [key === undefined ? local : stored, set];
}

/** Forgets what was opened (a test's clean slate; no row is mounted then). */
export function resetMessageOpen() {
  opened.clear();
}

// A note that a view from an older home was refused, so the page can say where MoMo runs now ("MoMo runs on <machine> now"). It clears when the next view is accepted.
import { useSyncExternalStore } from 'react';
import { currentHomeName } from './stampStore';

let note: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** A stale view was just dropped. */
export function noteStale() {
  note = currentHomeName() ?? 'another machine';
  emit();
}

/** The next accepted view settles it. */
export function clearStale() {
  if (note === null) return;
  note = null;
  emit();
}

/** The machine MoMo runs on now, while a stale answer was just refused; else null. */
export function useStaleNote(): string | null {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => note,
  );
}

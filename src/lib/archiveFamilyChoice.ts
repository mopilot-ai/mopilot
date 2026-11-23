// One serialized archive-family choice per window: stale buttons cannot answer a newer request and teardown cancels all.
import { useSyncExternalStore } from 'react';

export type ArchiveFamilyChoice = 'all' | 'parent' | null;
export type ArchiveFamilyDetails = { title: string; total: number; working: number };
type Choice = ArchiveFamilyDetails & { id: number; resolve: (answer: ArchiveFamilyChoice) => void };
const queue: Choice[] = [];
const listeners = new Set<() => void>();
let generation = 0;
const changed = () => {
  for (const listener of listeners) listener();
};
const current = () => queue[0] ?? null;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function requestArchiveFamilyChoice(details: ArchiveFamilyDetails): Promise<ArchiveFamilyChoice> {
  return new Promise((resolve) => {
    queue.push({ ...details, id: ++generation, resolve });
    changed();
  });
}

export function answerArchiveFamilyChoice(id: number, answer: ArchiveFamilyChoice) {
  const request = current();
  if (!request || request.id !== id) return;
  queue.shift();
  request.resolve(answer);
  changed();
}

/** The global dialog owner retires every request when the window/app view is disposed. */
export function cancelArchiveFamilyChoices() {
  const pending = queue.splice(0);
  for (const request of pending) request.resolve(null);
  changed();
}

export const useArchiveFamilyChoice = () => useSyncExternalStore(subscribe, current, current);

// Whether the Add a machine sheet is open: one place every entry (the host chip's Add machine…, Settings › Machines) opens, so the sheet is the same wherever it starts.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();
const setOpen = (next: boolean) => {
  if (next === open) return;
  open = next;
  for (const fn of [...listeners]) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const openAddMachine = () => setOpen(true);
export const closeAddMachine = () => setOpen(false);
export const useAddMachineOpen = () => useSyncExternalStore(subscribe, () => open);

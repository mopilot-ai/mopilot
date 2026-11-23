// Whether this window is docked as the computer-use panel (electron/capabilities/hostDock.cjs): while a chat holds the screen the window is a 520-wide corner panel, so it shows the chat alone, as Claude Desktop's panel does.
import { useSyncExternalStore } from 'react';

let docked = false;
const listeners = new Set<() => void>();

/** Main's "docked" command: on while the window is the panel, off once it is back in its place. */
export function setDocked(on: boolean): void {
  if (docked === on) return;
  docked = on;
  document.documentElement.classList.toggle('docked', on);
  for (const f of listeners) f();
}

/** The window's docked state, for the layout: the chat alone while docked. */
export function useDocked(): boolean {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => docked,
  );
}

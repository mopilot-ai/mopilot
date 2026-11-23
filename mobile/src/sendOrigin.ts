// The sent message rises from where the composer's box was at the tap to its place: Claude for iOS turns the composer's own text into the bubble. The tap measures the box before the send collapses it, and a ghost bubble rises while the real bubbles (the outbox's, then the pending copy, then the Mac's record) wait unseen underneath.
import { useSyncExternalStore } from 'react';

/** The window position of a view (null when it cannot be measured). */
export function measureTop(
  view: { measureInWindow?: (done: (x: number, y: number, w: number, h: number) => void) => void } | null,
): Promise<number | null> {
  return new Promise((resolve) => {
    if (!view?.measureInWindow) return resolve(null);
    view.measureInWindow((_x, y) => resolve(y));
  });
}

let watcher: ((y: number, refine?: boolean) => void) | null = null;
/** The chat's follow listens for where the sent bubble sits in the list; one chat is open at a time. */
export function watchSentTop(fn: (y: number, refine?: boolean) => void) {
  watcher = fn;
  return () => {
    if (watcher === fn) watcher = null;
  };
}
/** The sent bubble reports its place in the list's content whenever it is laid out; `refine`: the computer's own row of that message, which only corrects a place already reported (it is the last row of yours, not necessarily the one just sent). */
export const reportSentTop = (y: number, refine = false) => watcher?.(y, refine);

/** How long after the tap the measured start still belongs to it. */
export const RISE_WINDOW_MS = 2000;
type Start = Promise<number | null>;
let armed: { at: number; start: Start } | null = null;
/** A send was just tapped: `start` is the composer box's window top, measured before the send collapsed it. */
export function armRise(start: Start) {
  armed = { at: Date.now(), start };
}

export type Launch = { text: string; start: Start };
let launcher: ((launch: Launch) => void) | null = null;
/** The ghost bubble listens for sends; one chat is open at a time. */
export function watchLaunch(fn: (launch: Launch) => void) {
  launcher = fn;
  return () => {
    if (launcher === fn) launcher = null;
  };
}
/** The send went through: the ghost rises with its text from where the tap measured the composer. Hides the real bubbles until it lands. */
export function launchRise(text: string) {
  const taken = armed && Date.now() - armed.at < RISE_WINDOW_MS ? armed.start : null;
  armed = null;
  if (taken && launcher) {
    setRiding(true);
    launcher({ text, start: taken });
  }
}

let riding = false;
const listeners = new Set<() => void>();
/** True while the ghost rises: the real bubbles of the message are drawn invisible, so there is one bubble from the tap to the landing. */
export function setRiding(next: boolean) {
  if (riding === next) return;
  riding = next;
  listeners.forEach((l) => l());
}
export const isRiding = () => riding;
export const useRiding = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => riding,
  );

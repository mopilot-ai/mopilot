// A harness switch with nothing in the chat to decide (no goal, queued messages, permission or controller change, or
// multiple agents) goes ahead on the first click: the sheet confirms itself before it paints, and the switch chip
// above the composer offers Undo until the next message.
import { useLayoutEffect, useRef } from 'react';

/** Confirm once, before paint, when `quiet` held on the sheet's first render; true while it does (the sheet draws nothing). */
export function useQuickSwitch(quiet: boolean, confirm: () => void): boolean {
  // decided once: a sheet that opened with something to decide stays open even if that goes away
  const first = useRef(quiet);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!first.current || done.current) return;
    done.current = true;
    confirm();
  });
  return first.current;
}

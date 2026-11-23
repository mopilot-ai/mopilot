// The chat's single live status row under its task list and above the composer: waiting, running steps or agents,
// then background counts after the turn ends. Each active renderer moves its row here instead of drawing a second
// copy in the transcript (tests/oneRunningLine.invariant.test.ts); views without a slot render in place.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The chat's target: null before its ref mounts, undefined in a standalone view without a slot. */
export const StatusSlot = createContext<HTMLElement | null | undefined>(undefined);

/** The status target of this chat, including its not-yet-mounted state. */
export const useStatusSlot = () => useContext(StatusSlot);

/** Its children in the chat's status slot, or in place when the view has none. */
export function InStatusSlot({ children }: { children: ReactNode }) {
  const slot = useStatusSlot();
  return slot ? createPortal(children, slot) : children;
}

// Esc and the Stop button in the composer: stopping the turn, the second Esc's "Stop all" offer, and keeping the keyboard in the editor.

import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { interrupt, stopAllTasks } from '../../store/send';
import { toastFailure } from '../../store/core';
import { escStep } from '../../lib/tasks';

/**
 * `liveTasks`: the chat's running background tasks. The first Esc stops the turn; with tasks live, a second within 2 s
 * offers to stop them too, and Enter on that offer does. Stopping hands the keyboard back to the editor, so the next
 * message can be typed (#1658).
 */
export function useComposerStop(threadId: string | null, running: boolean, liveTasks: number, editor: RefObject<HTMLElement | null>) {
  const lastEsc = useRef(0);
  const [confirmStopAll, setConfirmStopAll] = useState(false);

  const stopTurn = () => {
    if (threadId) interrupt(threadId).catch(toastFailure("Couldn't stop"));
    editor.current?.focus();
  };

  /** Esc, and Enter on the "Stop all" offer: true when the key was the stop's, and the composer leaves it alone. */
  const onStopKey = (e: KeyboardEvent): boolean => {
    if (confirmStopAll && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      // cannot reject: stopping says itself when the request fails
      if (e.key === 'Enter' && threadId) void stopAllTasks(threadId);
      setConfirmStopAll(false);
      return true;
    }
    if (e.key !== 'Escape') return false;
    const live = threadId ? liveTasks : 0;
    const step = escStep(lastEsc.current, Date.now(), live);
    lastEsc.current = step.lastEsc;
    if (step.offer) {
      e.preventDefault();
      setConfirmStopAll(true);
      return true;
    }
    // with tasks live, this Esc arms "Stop all" for a second one, so the editor keeps the focus
    // (an unhandled Esc blurs it, and the second would land nowhere)
    if (live) e.preventDefault();
    if (!running || !threadId) return false;
    e.preventDefault();
    stopTurn();
    return true;
  };

  return { confirmStopAll, setConfirmStopAll, stopTurn, onStopKey };
}

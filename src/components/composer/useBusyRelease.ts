// A composer that is busy (a send preparing its references, a chat starting, another app running the turn) refuses edits, but never for long: past BUSY_RELEASE_MS it takes edits again and says so in the record (#5402).
import { useEffect, useState } from 'react';
import { noteRenderer, type BusyWhy } from '../../lib/rendererNote';
import { whyText } from '../../harness/caps';
import { toast } from '../../store/core';

/** How long a busy composer refuses edits; what it waits for is not cancelled, only the refusing. */
export const BUSY_RELEASE_MS = 5000;

/** Whether the busy state `why` has lasted past BUSY_RELEASE_MS (null: not busy); resets when the state changes or ends. */
export function useBusyRelease(why: BusyWhy | null): boolean {
  const [released, setReleased] = useState<BusyWhy | null>(null);
  useEffect(() => {
    if (!why) return setReleased(null);
    const timer = setTimeout(() => {
      noteRenderer({ what: 'composerBusyReleased', why, ms: BUSY_RELEASE_MS });
      setReleased(why);
    }, BUSY_RELEASE_MS);
    return () => {
      clearTimeout(timer);
      setReleased(null);
    };
  }, [why]);
  return !!why && released === why;
}

/** What a busy composer says it waits for in its empty editor. */
const NOTE = {
  locked: whyText({ layer: 'session', code: 'session.runningElsewhere' }),
  preparing: 'Sending…',
  starting: 'Starting the chat…',
} as const;

/**
 * Why the composer refuses edits, if it does: `busy` (it refuses), `busyWhy` (null once it lets go) and `busyNote`, the
 * placeholder that says what it waits for. The note outlives the release: what blocks the send is still there, so the
 * empty editor still says so, and `sayBlocked` is what a send pressed meanwhile answers with.
 */
export function useComposerBusy(lockedOut: boolean, preparing: boolean, starting: boolean) {
  const why: BusyWhy | null = lockedOut ? 'locked' : preparing ? 'preparing' : starting ? 'starting' : null;
  const released = useBusyRelease(why);
  const busy = !!why && !released;
  // a send pressed while one is under way is the same Enter twice: only an editor that let go, or another app's turn, answers
  // `block`: a send the machine's sign-in holds says its own reason elsewhere; `text` and `files` are what the person pressed Send on
  const sayBlocked = (block: unknown, text: string, files: number) => {
    if (!block && text.trim().length + files > 0 && why && (released || why === 'locked')) toast(NOTE[why]);
  };
  return { busy, busyWhy: busy ? why : null, busyNote: why ? NOTE[why] : null, sayBlocked };
}

/**
 * A send that prepared its references gives way when the editor no longer holds what it was sent from (typed meanwhile:
 * the editor takes edits again after a few seconds): the draft stays and this says so. A composer that was replaced or
 * closed says nothing, and neither does a send that another send replaced (`latest`: no other has started since).
 */
export function sayChanged(editor: { value: string } | null, sent: string, latest: boolean) {
  if (latest && editor && editor.value !== sent) toast('The message changed while it was sending. Send it again.');
}

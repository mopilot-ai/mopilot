// Reconcile pending image/text sends against authoritative rows and both queues without letting a late acknowledgment redraw a consumed send.
import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { heldOf } from './macQueue';
import { linkHeld, reconcileSent, unrecordedQueue, type Sent, type RowLike } from './sentMessages';
import type { Thread, Row } from './thread';
import { tidySteps } from './stepRows';
import { useMessagePreviews } from './useMessagePreviews';
import type { QueuedSend } from '../outbox';
export function useSettleSent(
  setSent: Dispatch<SetStateAction<Sent[]>>,
  sent: Sent[],
  thread: Thread | null,
  rows: RowLike[],
  queued: { id: string }[],
) {
  // the sends as this render saw them: read by the effect, which must not run again for them
  const seen = useRef(sent);
  seen.current = sent;
  useEffect(() => {
    if (!thread) return;
    const held = heldOf(thread.session);
    // nothing to settle (every streamed event asks, almost always with nothing to change): setting state with an updater would draw the whole screen once more just to find that out
    if (reconcileSent(seen.current, held, rows, queued) === seen.current) return;
    setSent((old) => reconcileSent(old, held, rows, queued));
  }, [setSent, thread, rows, queued]);
}

/** Both queues and the retained send use one native identity during acknowledgement/record overlap. */
export function pendingMessages(sent: Sent[], thread: Thread | null, rows: RowLike[], queued: QueuedSend[]) {
  const held = heldOf(thread?.session);
  const linked = linkHeld(sent, held);
  const visibleQueue = unrecordedQueue(queued, linked, rows).filter(
    (q) => !linked.some((s) => s.id === q.id && held.some((h) => h.id === s.remoteId)),
  );
  const picturesFor = (id: string) => linked.find((send) => send.id === id || send.remoteId === id)?.pictures;
  return { held, linked, visibleQueue, picturesFor };
}

/** The chat's tidied rows with local previews on the pictures of your own messages, keyed by this account, pair and chat. */
export function usePreviewedRows<T extends Row>(
  runtime: { snapshot(): { user?: { id?: string } | null; selectedPair?: string | null } },
  chatId: string,
  all: T[],
  sent: Sent[],
  queued: QueuedSend[],
): T[] {
  const { user, selectedPair } = runtime.snapshot();
  return useMessagePreviews(
    JSON.stringify([user?.id, selectedPair, chatId]),
    useMemo(() => tidySteps(all), [all]),
    sent,
    queued,
  );
}

/** Settles the sends against the rows and both queues, and says what is still waiting. */
export function usePendingMessages(
  setSent: Dispatch<SetStateAction<Sent[]>>,
  sent: Sent[],
  thread: Thread | null,
  rows: RowLike[],
  queued: QueuedSend[],
) {
  useSettleSent(setSent, sent, thread, rows, queued);
  return pendingMessages(sent, thread, rows, queued);
}

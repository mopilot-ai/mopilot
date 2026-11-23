// MoMo's page keeps your sent line on screen from the tap until the Mac's own record of it is among the chat's rows, as every other chat does.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import type { QueuedSend } from '../outbox';
import { queueCalls } from '../components/QueuedMessages';
import { usePendingMessages } from '../presentation/useSentMessages';
import { waitingForRecord, withSent, type Sent } from '../presentation/sentMessages';
import type { Thread, Row } from '../presentation/thread';
import type { MomoRow } from './chatRows';

/**
 * The outbox lets a send go the moment the Mac takes it, and the Mac records the line only once its turn reads it: in
 * between nothing showed but "Working…". `waiting` is that gap: sends acknowledged but not yet recorded, drawn as your
 * bubbles. A send the outbox or the Mac's queue still shows is theirs to draw, never drawn twice here.
 */
export function useSentLines(thread: Thread | null, rows: MomoRow[], queued: QueuedSend[], scope: string) {
  const [sent, setSent] = useState<Sent[]>([]);
  const lines: Row[] = rows.flatMap((r) => (r.kind === 'message' ? [r.row] : []));
  const linesRef = useRef(lines);
  linesRef.current = lines;
  // another account or computer: what was sent to the first is not waiting for the second
  useEffect(() => {
    void scope;
    setSent([]);
  }, [scope]);
  const { held, linked } = usePendingMessages(setSent, sent, thread, lines, queued);
  const heldIds = useRef<string[]>([]);
  heldIds.current = held.map((h) => h.id);
  const waiting = waitingForRecord(linked, lines, [...queued, ...held]);
  /** Remember a send from the tap, with the rows and the Mac's queue as they were. */
  const note = useCallback((id: string, text: string) => setSent((old) => withSent(old, linesRef.current, text, id, heldIds.current)), []);
  /** The outbox's three calls; a cancelled send is forgotten and an edited one waits for its new words. */
  const calls = (runtime: MobileRuntime) => {
    const own = queueCalls(runtime);
    return {
      ...own,
      cancel: (id: string) => {
        const ok = own.cancel(id);
        if (ok) setSent((old) => old.filter((s) => s.id !== id));
        return ok;
      },
      edit: (id: string, text: string) => {
        const ok = own.edit(id, text);
        if (ok)
          setSent((old) =>
            withSent(
              old.filter((s) => s.id !== id),
              linesRef.current,
              text,
              id,
              heldIds.current,
            ),
          );
        return ok;
      },
    };
  };
  return { waiting, note, calls };
}

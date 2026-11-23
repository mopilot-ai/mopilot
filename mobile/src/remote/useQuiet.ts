// Whether a working chat has been silent for a while: the turn line then says "No recent update" instead of "Working", so the phone never claims what it cannot confirm.
import { useEffect, useState } from 'react';
import { QUIET_AFTER_MS } from '../presentation/chatChips';
import { progress, type Thread } from '../presentation/thread';

export const QUIET_LINE = 'No recent update';

/**
 * True once the turn has been running and `thread` has not changed for QUIET_AFTER_MS. `thread` is a new object with every feed event, so
 * the silence is counted from the last one (or from the chat being read); a new object ends it in the same render, with no frame between.
 */
export function useQuiet(thread: Thread | null) {
  const status = thread?.session.turnStatus;
  const running = status === 'running' || status === 'inProgress';
  const [quietAt, setQuietAt] = useState<Thread | null>(null);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setQuietAt(thread), QUIET_AFTER_MS);
    // a silence being counted must not keep a process alive; React Native timers have no unref
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  }, [running, thread]);
  return running && quietAt === thread;
}

/** The line under MoMo's chat while it works. */
export function useProgressLine(thread: Thread | null) {
  const quiet = useQuiet(thread);
  return quiet ? QUIET_LINE : progress(thread?.session.turnStatus);
}

// Fresh history reads recover from concurrent live items without ever publishing their retired snapshots.
import { get, patchRuntime } from './core';
import { readFailed } from './chatReads';
import { deletionVisibility } from './deletionVisibility';

const opens = new Map<string, object>();

/** All harness readers share a chat's loading owner, including a replacement after a source switch. */
export function beginHistoryOpen(id: string, loading = true) {
  const owner = {};
  opens.set(id, owner);
  if (loading) patchRuntime(id, () => ({ loading: true }));
  const newest = () => opens.get(id) === owner;
  return {
    owns: () => newest() && !!get().runtime[id] && !deletionVisibility.has(id),
    finish: () => {
      if (!newest()) return;
      opens.delete(id);
      if (get().runtime[id]) patchRuntime(id, () => ({ loading: false }));
    },
  };
}

/** A false result retired its snapshot; reread under the same owner, with a bounded, visible failure. */
export async function readStableTranscript(
  id: string,
  owns: () => boolean,
  flush: () => void,
  read: (unchanged: () => boolean) => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    flush();
    if (!owns()) return;
    const shown = get().runtime[id]?.turns;
    const segments = get().segments[id];
    const unchanged = () => owns() && get().runtime[id]?.turns === shown && get().segments[id] === segments;
    if (await read(unchanged)) return;
  }
  if (owns())
    patchRuntime(id, () => ({
      ...readFailed(new Error('The chat kept changing while its history loaded. Try again.')),
      // The live tail alone is not loaded history, even while this app holds the chat's lease.
      loaded: false,
    }));
}

// The rows an open chat paints before the Mac answers (memory, else the sealed copy on disk), and the keeping of what it shows for next time.
import { useEffect, useRef, useState } from 'react';
import type { ChatCache } from '../presentation/chatCache';
import { forgetRow, recentRows, rememberRows, type CachedRow } from '../presentation/threadCache';
import type { fold } from '../presentation/toolRuns';

/** How long after the last change the sealed copy is written; leaving the chat writes it at once. */
const SAVE_AFTER_MS = 1500;

/** `view` is null until the Mac's rows have arrived: only those are kept, never the cached ones shown meanwhile. */
export function useChatRows(
  historyKey: string | undefined,
  rowCache: ChatCache | null | undefined,
  view: ReturnType<typeof fold> | null,
): CachedRow[] {
  const [saved, setSaved] = useState<{ key: string; rows: CachedRow[] } | null>(null);
  useEffect(() => {
    if (!historyKey || !rowCache || recentRows(historyKey).length) return;
    let live = true;
    rowCache
      .load(historyKey)
      .then((rows) => live && setSaved({ key: historyKey, rows }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [historyKey, rowCache]);
  const keep = useRef<{ key: string; rows: CachedRow[] } | null>(null);
  // writes the last rows kept to the sealed copy; read through a ref, so the timer and the unmount always call the current one
  const flushLast = useRef<() => void>(() => undefined);
  flushLast.current = () => {
    const kept = keep.current;
    keep.current = null;
    if (kept && rowCache) void rowCache.save(kept.key, kept.rows).catch(() => undefined);
  };
  useEffect(() => {
    if (!historyKey || !view) {
      // nothing from the Mac to keep (the chat is reading again, or it is gone): what was kept for the save is dropped
      keep.current = null;
      return;
    }
    // only what the cached rows draw: a step's screenshot stays with the live chat
    const rows = view.blocks.map((b) =>
      b.type === 'run' ? { key: `run:${b.key}`, role: 'step', text: b.summary } : { key: b.row.key, role: b.row.role, text: b.row.text },
    );
    rememberRows(historyKey, rows);
    keep.current = { key: historyKey, rows };
    const timer = setTimeout(() => flushLast.current(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [historyKey, view]);
  useEffect(() => () => flushLast.current(), []);
  if (!historyKey) return [];
  const memory = recentRows(historyKey);
  return memory.length ? memory : saved?.key === historyKey ? saved.rows : [];
}

/** A refusal that says the chat no longer exists on the computer. */
const GONE =
  /no such chat|unknown chat|\bchat\b[^.]{0,40}\b(not found|does not exist|no longer exists|was deleted|is gone)|that chat isn['’]t in MoPilot(?: Code)?(?=[.!]|$)/i;

/** The Mac's answer says the chat does not exist (a deleted chat, or a link to one this Mac never had): there is nothing to retry and nothing to send to. */
export const isGone = (message: string | null | undefined) => !!message && GONE.test(message);

/** The chat is gone from the Mac: what was kept for it, in memory and sealed, goes too. */
export function forgetIfGone(message: string, historyKey: string | undefined, rowCache: ChatCache | null | undefined) {
  if (!historyKey || !isGone(message)) return;
  forgetRow(historyKey);
  void rowCache?.remove(historyKey).catch(() => undefined);
}

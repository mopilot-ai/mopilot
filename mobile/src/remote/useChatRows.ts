// The rows an open chat paints before the Mac answers (memory, else the sealed copy on disk), and the keeping of what it shows for next time.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatCache } from '../presentation/chatCache';
import type { PagedChatCache } from './pageCache';
import { earlierRow } from './earlier';
import {
  CACHE_ROWS,
  forgetRow,
  recentChanges,
  recentRows,
  rememberRows,
  type CachedRow,
  type SavedChanges,
} from '../presentation/threadCache';
import type { fold } from '../presentation/toolRuns';

/** The saved older rows shown above the first paint while the Mac does not answer: the newest this many of those that join it. */
export const ASLEEP_OLDER = 200;
/** How many of the first paint's oldest rows may be the one the saved rows join at (a folded run of steps before it is not a row the saved rows have). */
const JOIN_AMONG = 5;

/** The saved rows above where they meet the first paint, or null when they do not meet it: a first-paint row with the same key, role and text. */
export function olderThan(saved: readonly CachedRow[], paint: readonly CachedRow[]): { above: CachedRow[]; from: number } | null {
  for (let from = 0; from < Math.min(JOIN_AMONG, paint.length); from++) {
    const row = paint[from];
    const at = saved.findIndex((r) => r.key === row.key && r.role === row.role && r.text === row.text);
    if (at >= 0) return { above: saved.slice(Math.max(0, at - ASLEEP_OLDER), at), from };
  }
  return null;
}

/** How long after the last change the sealed copy is written; leaving the chat writes it at once. */
const SAVE_AFTER_MS = 1500;

type Kept = { key: string; rows: CachedRow[]; changes: SavedChanges | null };

/**
 * `view` is null until the Mac's rows have arrived: only those are kept, never the cached ones shown meanwhile. `counts`: the Mac's own read
 * of the lines changed (undefined until it answers, and while a turn runs; null when it could not say). The rows come back with the chip to
 * show under them: the one the chat was left with until the Mac's first count since it opened (so the answer does not add it under the
 * reader), then the Mac's counts (none while a finished turn waits to be counted). A count that failed says nothing new: the last answer
 * stays, shown and kept, so a Mac that drops away does not take the chip from under the reader.
 */
export function useChatRows(
  historyKey: string | undefined,
  rowCache: PagedChatCache | null | undefined,
  view: ReturnType<typeof fold> | null,
  counts?: SavedChanges | null,
): { rows: CachedRow[]; changes: SavedChanges | null } {
  const [saved, setSaved] = useState<Kept | null>(null);
  useEffect(() => {
    if (!historyKey || !rowCache || recentRows(historyKey).length) return;
    let live = true;
    rowCache
      .loadChat(historyKey)
      .then((chat) => live && setSaved({ key: historyKey, ...chat }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [historyKey, rowCache]);
  // the older rows saved sealed for this chat (the page cache), as the same plain rows
  const pages = rowCache?.pages;
  const [older, setOlder] = useState<{ key: string; rows: CachedRow[] } | null>(null);
  useEffect(() => {
    if (!historyKey || !pages) return;
    let live = true;
    pages.load(historyKey).then(
      (copy) => {
        const rows = (copy?.rows ?? []).map((r) => {
          const item = earlierRow(r);
          return { key: item.key, role: item.role, text: item.text };
        });
        if (live) setOlder({ key: historyKey, rows });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [historyKey, pages]);
  const keep = useRef<Kept | null>(null);
  // writes the last rows kept to the sealed copy; read through a ref, so the timer and the unmount always call the current one
  const flushLast = useRef<() => void>(() => undefined);
  flushLast.current = () => {
    const kept = keep.current;
    keep.current = null;
    if (kept && rowCache) void rowCache.save(kept.key, kept.rows, kept.changes).catch(() => undefined);
  };
  // (no key keeps nothing: nothing is ever remembered under '')
  const key = historyKey ?? '';
  const memory = recentRows(key);
  const fromDisk = saved?.key === historyKey ? saved : null;
  const left = memory.length ? recentChanges(key) : (fromDisk?.changes ?? null);
  const counted = useRef(false);
  if (!view) counted.current = false;
  else if (counts) counted.current = true;
  // kept with the rows: the last count the Mac gave (it answers after the rows), so a chat left while a turn ran opens with its chip
  const known = counts ?? left;
  const changesKey = JSON.stringify(known);
  useEffect(() => {
    if (!historyKey || !view) {
      // nothing from the Mac to keep (the chat is reading again, or it is gone): what was kept for the save is dropped
      keep.current = null;
      return;
    }
    // only what the cached rows draw: a step's screenshot stays with the live chat
    const rows = view.blocks
      .slice(-CACHE_ROWS)
      .map((b) =>
        b.type === 'run' ? { key: `run:${b.key}`, role: 'step', text: b.summary } : { key: b.row.key, role: b.row.role, text: b.row.text },
      );
    const chip = JSON.parse(changesKey) as SavedChanges | null;
    rememberRows(historyKey, rows, chip);
    keep.current = { key: historyKey, rows, changes: chip };
    const timer = setTimeout(() => flushLast.current(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [historyKey, view, changesKey]);
  useEffect(() => () => flushLast.current(), []);
  const paint = memory.length ? memory : (fromDisk?.rows ?? []);
  const loaded = historyKey !== undefined && older?.key === historyKey ? older.rows : null;
  // the saved older rows join the first paint only where they meet it; rows that do not are not the Mac's history of this chat
  const joined = useMemo(() => (loaded && paint.length ? olderThan(loaded, paint) : null), [loaded, paint]);
  useEffect(() => {
    // only while the first paint is what is shown: once the Mac's rows are in, the chat's own screen decides what belongs
    if (historyKey && pages && !view && loaded?.length && paint.length && !joined) void pages.discard(historyKey).catch(() => undefined);
  }, [historyKey, pages, view, loaded, paint.length, joined]);
  const rows = useMemo(() => (joined ? [...joined.above, ...paint.slice(joined.from)] : paint), [joined, paint]);
  return { rows, changes: counted.current ? (counts === undefined ? null : known) : left };
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

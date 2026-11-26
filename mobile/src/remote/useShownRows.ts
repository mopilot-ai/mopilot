// What a chat's list shows: the Mac's rows, or before they come the rows it last showed, drawn alike (folded the same, with the same "Worked" line and Changes chip) so the Mac's answer adds nothing under the reader.
import { useMemo, useState } from 'react';
import type { PagedChatCache } from './pageCache';
import { savedView } from '../presentation/cachedBlocks';
import { withPendingRows } from '../presentation/thread';
import type { SavedChanges } from '../presentation/threadCache';
import { fold, type KeyedRow } from '../presentation/toolRuns';
import { lastTurn } from '../presentation/workingLine';
import { waitingForRecord } from '../presentation/sentMessages';
import { useChatRows } from './useChatRows';

/**
 * `rows`: the Mac's rows (none until they come, `loaded` false); `counts`: the Mac's read of the lines changed. While the saved rows show, the
 * turn they end with is folded and drawn as the live chat will draw it, and the chip is the one the chat was left with.
 */
export function useShownRows(o: {
  rows: KeyedRow[];
  loaded: boolean;
  running: boolean;
  historyKey: string | undefined;
  rowCache: PagedChatCache | null | undefined;
  counts: SavedChanges | null | undefined;
  linked: Parameters<typeof waitingForRecord>[0];
  pending: Parameters<typeof waitingForRecord>[2];
}) {
  const { rows, loaded, running } = o;
  // the turn whose steps were folded by a tap: the key of your message that began it, so the next turn shows its steps again
  const [foldedTurn, setFoldedTurn] = useState<string | null>(null);
  // kept as the chat opens again: unfolded (as it opens), with the chip it had
  const unfolded = useMemo(() => fold(rows, { running, foldedTurn: null }), [rows, running]);
  const { rows: saved, changes } = useChatRows(o.historyKey, o.rowCache, loaded ? unfolded : null, o.counts);
  const shown = loaded ? rows : saved;
  const turn = useMemo(() => lastTurn(shown), [shown]);
  const waiting = waitingForRecord(o.linked, shown, o.pending);
  const list = loaded
    ? fold(withPendingRows(rows, waiting), { running, foldedTurn })
    : savedView(withPendingRows(saved, waiting), foldedTurn);
  const toggle = list.activity > 0 ? () => setFoldedTurn(foldedTurn === list.turnKey ? null : list.turnKey) : undefined;
  return { saved, shown, changes, turn, waiting, list, folded: foldedTurn === list.turnKey, toggle };
}

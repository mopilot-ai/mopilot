// The thread's turns as it shows them: quiet woken turns folded (src/lib/wokenTurns.ts), and the turn each slot of the window stands for.
import { useMemo } from 'react';
import type { TurnState } from '../../../store/types';
import { entrySlots, foldWokenTurns, type ThreadEntry } from '../../../lib/wokenTurns';
import { sideSessionForItem, useOrchestrationSelect } from '../../../lib/sideSessions';

export interface ThreadEntries {
  entries: ThreadEntry[];
  /** one turn per window slot: a turn of its own, or the first of a folded run */
  slots: TurnState[];
  /** the slot a turn shows in (a folded turn's is its run's first), so pinning a turn keeps its row rendered */
  slotOf: (id: string | null | undefined) => string | null | undefined;
}

export function useThreadEntries(turns: TurnState[], liveId: string | null): ThreadEntries {
  // only what main delivered other sessions' items as: a linked session's clock moving does not fold the thread again
  const deliveries = useOrchestrationSelect((v) => v.deliveries);
  return useMemo(() => {
    const entries = foldWokenTurns(turns, { liveId, deliveryOf: (item) => sideSessionForItem({ deliveries }, item) });
    const map = entrySlots(entries);
    return {
      entries,
      slots: entries.map((e) => (e.kind === 'turn' ? e.turn : e.turns[0])),
      slotOf: (id) => (id ? (map.get(id) ?? id) : id),
    };
  }, [turns, liveId, deliveries]);
}

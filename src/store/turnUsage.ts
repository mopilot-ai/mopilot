// What a finished turn sends as usage data: a coding chat's turn is shared, a MoMo chat's only counted, nothing with sharing off.
import { shareUsageDataEnabled } from '../../shared/usageData.mjs';
import { countTurn, shareTurn } from '../lib/telemetry';
import { isMomoChat } from '../lib/momoChats';
import { get } from './core';
import { usageHarnessOf } from './chats';
import type { TurnState } from './types';

/**
 * MoMo's chats are personal: their turns are counted, so the release train sees the build was used, and their content is
 * never shared (main refuses it again, electron/private/analytics/telemetry.cjs shareTurn).
 */
export function reportFinishedTurn(threadId: string, turn: { id: string; status?: TurnState['status'] }) {
  const s = get();
  if (!shareUsageDataEnabled(s.prefs.shareUsageData)) return;
  if (isMomoChat(s.momoChats, threadId)) return countTurn(threadId, turn.status);
  const r = s.runtime[threadId];
  const t = r?.turns.find((x) => x.id === turn.id);
  if (t)
    shareTurn(
      threadId,
      usageHarnessOf(threadId),
      r?.settings?.model ?? null,
      { ...t, status: turn.status ?? t.status },
      r?.tokenUsage?.last ?? null,
    );
}

// The message a window shows at once for a send that main prepares first (a harness switch, #1663), before any harness says
// it started the turn; the harness's turnStarting then adopts it (src/store/pendingTurns.ts), or a failed send settles it here.
import type { ThreadItem } from './types';
import { newTurn, patchRuntime } from './core';
import { earlyTurnId, settleOtherTurns } from './pendingTurns';

/** The message in a turn of its own, as a harness's turnStarting shows it; `itemId` is the request id the send carries to main. */
export function showEarlyTurn(chatId: string, itemId: string, content: unknown) {
  const id = earlyTurnId(itemId);
  const bubble = { type: 'userMessage', id: `local-${itemId}`, clientId: itemId, content } as ThreadItem;
  patchRuntime(chatId, (r) => ({
    turns: settleOtherTurns([...r.turns.filter((t) => t.id !== id), { ...newTurn(id), items: [bubble] }], id),
    activeTurnId: id,
    error: null,
  }));
}

/**
 * The early copy of a send that did not become a started turn. `failed`: it stays, marked failed with the reason and what
 * to do (main kept the message in the queue); otherwise it goes, because the message is back with the user (composer) or
 * shown by the queue. A copy its harness already adopted is gone, so a late answer changes nothing.
 */
export function settleEarlyTurn(chatId: string, itemId: string, failed: string | null) {
  const id = earlyTurnId(itemId);
  patchRuntime(chatId, (r) => {
    const turn = r.turns.find((t) => t.id === id);
    if (!turn) return {};
    const activeTurnId = r.activeTurnId === id ? null : r.activeTurnId;
    if (failed === null) return { turns: r.turns.filter((t) => t !== turn), activeTurnId };
    return { turns: r.turns.map((t) => (t === turn ? { ...t, status: 'failed', error: { message: failed } } : t)), activeTurnId };
  });
}

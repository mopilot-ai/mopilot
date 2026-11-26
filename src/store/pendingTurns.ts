// The turn list with a harness's pending turn (`pending-<clientId>`) added: the one rule every harness's turnStarting shares,
// the one-running-turn rule every turn start keeps (#2332), and the turn list after a rewind.
import type { TurnState } from './types';

/** The early turn's id for a send: `itemId` is the request id the window sent, which main keeps as the queue item's id. */
export const earlyTurnId = (itemId: string) => `pending-${itemId}`;

/**
 * `turns` with every turn but `startedId` that is still `inProgress` settled now: a chat runs one turn at a time, so a
 * new turn starting means an older one's end never arrived (a transcript tail reopened while it was still being
 * written, a lost completion). It ends as Claude's translator ends a turn the next one replaces, interrupted, so its
 * steps still open read as cut off; its harness's own completion, if it comes later, still sets how it ended.
 */
export function settleOtherTurns(turns: TurnState[], startedId: string): TurnState[] {
  if (!turns.some((t) => t.id !== startedId && t.status === 'inProgress')) return turns;
  const now = Date.now() / 1000;
  return turns.map((t) => (t.id !== startedId && t.status === 'inProgress' ? { ...t, status: 'interrupted', completedAt: now } : t));
}

/**
 * `turns` with `turn` last. `itemId` (the send's request id) names the early copy of the message this window showed for
 * the same send (src/store/earlyTurn.ts), which the harness's own turn replaces, so the message shows once.
 */
export function addPendingTurn(turns: TurnState[], turn: TurnState, itemId?: string): TurnState[] {
  const early = itemId ? earlyTurnId(itemId) : null;
  return settleOtherTurns([...turns.filter((t) => t.id !== early), turn], turn.id);
}

/** Trim a loaded conversation before the rewound turn, if that turn is loaded. */
export function rewindTurns(turns: TurnState[], turnId: string): Partial<{ turns: TurnState[] }> {
  const before = turns.findIndex((turn) => turn.id === turnId);
  return before < 0 ? {} : { turns: turns.slice(0, before) };
}

/**
 * `turns` when `id`, a turn they already hold, starts again. A read that came before main said so shows it as interrupted:
 * it is running, and this is the word that it is.
 * @param {TurnState[]} turns @param {string} id
 */
export function restartedTurn(turns: TurnState[], id: string): TurnState[] {
  return settleOtherTurns(turns, id).map((t) => (t.id === id && t.status === 'interrupted' ? { ...t, status: 'inProgress' } : t));
}

// What a Claude Code or ACP turn changed in its folder, from main's snapshots (electron/session/turnSnapshots.cjs), on @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).
// the turn by its key: a window knows a turn as pending-, ct- or at- live and h- read back (shared/turnKey.mjs).
import { turnKey } from '../../shared/turnKey.mjs';
import { native } from '../lib/native';
import { get, patchRuntime } from './core';
import { outputCompletion } from './outputCompletion';

/** diff null: main takes back a live diff its final snapshot couldn't confirm, so the turn reads from its items again. */
export type TurnDiff = { chatId: string; turnId: string; diff: string | null };

/** A turn this window doesn't show gets nothing: the chat reads its saved diff when it opens. */
export function applyTurnDiff({ chatId, turnId, diff }: TurnDiff) {
  const key = turnKey(turnId);
  const turn = get().runtime[chatId]?.turns.find((t) => turnKey(t.id) === key);
  if (!turn) return;
  const afterOutput = diff === null ? null : outputCompletion(chatId, turn.id, { diff });
  patchRuntime(chatId, (r) => ({ turns: r.turns.map((t) => (turnKey(t.id) === key ? { ...t, diff: diff ?? undefined } : t)) }));
  afterOutput?.();
}

export function followTurnDiffs() {
  native.session.onTurnDiff(applyTurnDiff);
}

/** The turn's Undo (true) or Redo (false) went through: the Changes panel follows the disk, the turn's card its label. */
export function markTurnUndone(chatId: string, turnId: string, undone: boolean) {
  const key = turnKey(turnId);
  patchRuntime(chatId, (r) => ({ turns: r.turns.map((t) => (turnKey(t.id) === key ? { ...t, undone } : t)) }));
}

// Keeping a turn's object while its saved notes are merged in again, so a memoized turn view sees no change.

/** Each merged turn, by the turn it was merged from, with the notes it was merged with. */
export type NotedTurns<T extends object, N> = WeakMap<T, { notes: N; turn: T }>;

/**
 * `merged` is `raw` with notes merged into copies of some turns (withChatNotes). A copy whose source turn and notes
 * are the ones a previous call merged is swapped for that call's copy, so only a turn that changed gets a new object.
 */
export function keepNotedTurns<T extends object, N>(raw: readonly T[], merged: T[], notes: N, cache: NotedTurns<T, N>): T[] {
  return merged.map((turn, i) => {
    const source = raw[i];
    if (turn === source || !source) return turn;
    const before = cache.get(source);
    if (before && before.notes === notes) return before.turn;
    cache.set(source, { notes, turn });
    return turn;
  });
}

// How many chats a folded sidebar list shows and what its Show more / Show less row offers, as Claude Code's sidebar does.

/** Each "Show N more" reveals this many more chats. */
export const STEP = 5;

/** What the row under a folded list offers: more chats, Show less, Show less held by the open chat, or nothing. */
export type WindowFoot = { kind: 'more'; count: number } | { kind: 'less' } | { kind: 'held' } | null;

export type ChatWindow<T> = {
  visible: T[];
  foot: WindowFoot;
  /** The `revealed` that Show more stores. */
  more: number;
};

/** True when showing `shown` of `total` chats would leave at least two hidden: one hidden chat is shown instead of a row. */
const folds = (total: number, shown: number) => total > shown + 1;

/**
 * The window over `rows`: the first `first` plus `revealed` more, stretched to reach every required chat. Show more
 * reveals STEP at a time; Show less appears only once nothing is hidden and folds back to `first` (required chats
 * still shown). When a required chat sits so near the end that folding would hide nothing, Show less is held.
 */
export function chatWindow<T>(rows: readonly T[], first: number, revealed: number, isRequired: (row: T) => boolean): ChatWindow<T> {
  const last = rows.findLastIndex(isRequired);
  const floor = Math.max(0, last + 1 - first);
  const extra = Math.max(revealed, floor);
  const total = rows.length;
  if (folds(total, first + extra)) {
    const hidden = total - first - extra;
    const count = folds(total, first + extra + STEP) ? STEP : hidden;
    return { visible: rows.slice(0, first + extra), foot: { kind: 'more', count }, more: extra + count };
  }
  const foot: WindowFoot =
    revealed <= 0
      ? null
      : revealed > floor && folds(total, first + floor)
        ? { kind: 'less' }
        : folds(total, first)
          ? { kind: 'held' }
          : null;
  return { visible: [...rows], foot, more: revealed };
}

// How many chats a project's card shows and what the row under it offers ("Show N more", "Show less"): the rule of the Mac's sidebar (src/components/sidebar/chatWindow.ts) with the phone's own sizes, so one project cannot fill the whole list.

/** A project shows this many of its chats until "Show more" reveals the rest (the Mac shows 5). */
export const PROJECT_FIRST = 10;
/** Each "Show N more" reveals up to this many more (the Mac's step is 5). */
export const PROJECT_STEP = 10;

/** What the row under a project's chats offers: more chats, Show less, or nothing. */
export type WindowFoot = { kind: 'more'; count: number } | { kind: 'less' } | null;

export type ChatWindow<T> = {
  visible: T[];
  foot: WindowFoot;
  /** The `revealed` that Show more stores. */
  more: number;
};

/** True when showing `shown` of `total` chats would leave at least two hidden: one hidden chat is shown instead of a row. */
const folds = (total: number, shown: number) => total > shown + 1;

/**
 * The window over `rows`: the first `first` plus `revealed` more. Show more reveals `step` at a time (the last
 * hidden chat is shown rather than named in a row); Show less appears once nothing is hidden and folds back to `first`.
 */
export function chatWindow<T>(rows: readonly T[], first: number, step: number, revealed: number): ChatWindow<T> {
  const total = rows.length;
  if (folds(total, first + revealed)) {
    const hidden = total - first - revealed;
    const count = folds(total, first + revealed + step) ? step : hidden;
    return { visible: rows.slice(0, first + revealed), foot: { kind: 'more', count }, more: revealed + count };
  }
  return { visible: [...rows], foot: revealed > 0 && folds(total, first) ? { kind: 'less' } : null, more: revealed };
}

// A turn's "Worked for" fold, kept while a long thread shows the turn as a placeholder, for one visit of the chat.

import { createContext, useCallback, useContext, useState } from 'react';

/**
 * The turns whose work the reader unfolded in this visit of the chat, by turn id. The thread view provides one set
 * per visit (per chat, per mount), so a turn that left the window renders as it was left, while opening the chat
 * again (after Settings, or another chat) starts with every turn folded, as it did before turns were windowed.
 */
export const UnfoldedTurns = createContext<Set<string> | null>(null);

/**
 * A turn's "Worked for" fold, kept across the turn leaving the window and coming back within the same visit.
 *
 * The fold is read once, at mount: the thread view keys each turn's slot by [chat, turn] and replaces the set only
 * when the chat changes, so an instance is never handed another turn or another visit's set while it stays mounted.
 * Narrowing that key would leave this read showing the fold it mounted on (tests/threadWindowing.test.ts pins both).
 */
export function useKeptUnfold(turnId: string): [boolean, (update: (open: boolean) => boolean) => void] {
  const unfolded = useContext(UnfoldedTurns);
  const [open, setOpen] = useState(() => !!unfolded?.has(turnId));
  const update = useCallback(
    (next: (open: boolean) => boolean) =>
      setOpen((previous) => {
        const value = next(previous);
        if (value) unfolded?.add(turnId);
        else unfolded?.delete(turnId);
        return value;
      }),
    [unfolded, turnId],
  );
  return [open, update];
}

// The row under a folded sidebar list ("Show N more", "Show less", or Show less held by an open chat near the end), and a list folded in its own state.
import { useState } from 'react';
import { type WindowFoot as Foot, chatWindow } from './chatWindow';

const HELD = 'You have a session open or active near the end of this list.';

export function WindowFoot({
  foot,
  label,
  onMore,
  onLess,
  className = '',
}: {
  foot: Foot;
  /** the list's name, for the screen-reader label */
  label: string;
  onMore: () => void;
  onLess: () => void;
  className?: string;
}) {
  if (!foot) return null;
  const more = foot.kind === 'more';
  return (
    <button
      className={`side-row show-more ${className}`}
      aria-label={more ? `Show ${foot.count} more in ${label}` : `Show less in ${label}${foot.kind === 'held' ? `. ${HELD}` : ''}`}
      aria-disabled={foot.kind === 'held' || undefined}
      title={foot.kind === 'held' ? HELD : undefined}
      onClick={more ? onMore : foot.kind === 'less' ? onLess : undefined}
    >
      <span className="side-row-label">{more ? `Show ${foot.count} more` : 'Show less'}</span>
    </button>
  );
}

/** A list folded in its own state (Pinned, Recents, the one-list view): the rows it shows and the row under them. */
export function useFoldedList<T>(rows: readonly T[], first: number, isRequired: (row: T) => boolean, label: string) {
  const [revealed, setRevealed] = useState(0);
  const { visible, foot, more } = chatWindow(rows, first, revealed, isRequired);
  return {
    visible,
    foot: <WindowFoot foot={foot} label={label} onMore={() => setRevealed(more)} onLess={() => setRevealed(0)} className="recents" />,
  };
}

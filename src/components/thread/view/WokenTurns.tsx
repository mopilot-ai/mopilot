// A run of turns no one typed folded into one row ("Monitor · CI run · Woke 5 times over 12m"), opening to each turn.
import { Fragment, useState, type ReactNode } from 'react';
import { Collapse } from '../../ui/Presence';
import { Activity, ChevronDown } from '../../ui/icons';
import type { TurnState } from '../../../store/types';
import { wokenSummary, type ThreadEntry } from '../../../lib/wokenTurns';

export function WokenTurns({
  entry,
  renderTurn,
  target,
}: {
  entry: Extract<ThreadEntry, { kind: 'woken' }>;
  renderTurn: (turn: TurnState) => ReactNode;
  /** the turn a jump from the rail is going to: the row opens while it is one of its own */
  target?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // a jump into the row opens it until the reader folds it again (the jump's target stays set after it lands)
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  const shown = open || (!!target && target !== foldedFor && entry.turns.some((t) => t.id === target));
  const sum = wokenSummary(entry);
  return (
    <div className={`woken-turns step-group ${shown ? 'open' : ''}`}>
      <button
        type="button"
        className="step-row summary"
        aria-expanded={shown}
        onClick={() => {
          setOpen(!shown);
          setFoldedFor(shown ? (target ?? null) : null);
        }}
      >
        <span className="step-icon">
          <Activity size={16} strokeWidth={1.6} />
        </span>
        <span className="step-text">
          {sum.label}
          <span className="step-em"> · {sum.text}</span>
          {sum.failed ? <span className="step-exit"> · {sum.failed} failed</span> : null}
        </span>
        <ChevronDown size={14} className="step-chevron" />
      </button>
      <Collapse open={shown}>
        <div className="woken-turns-list">
          {entry.turns.map((t) => (
            <Fragment key={t.id}>{renderTurn(t)}</Fragment>
          ))}
        </div>
      </Collapse>
    </div>
  );
}

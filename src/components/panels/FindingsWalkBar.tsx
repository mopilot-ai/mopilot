// The strip under the Changes pane's head while a review's findings are walked: where the fixes stand, Previous and Next, Dismiss.

import { closeFindingsWalk, focusFinding, rerunReview } from '../../store/reviews';
import { ChevronLeft, ChevronRight } from '../ui/icons';
import { useFindingsWalk } from './useFindingsWalk';

/**
 * What the walk says: fixes running; every finding not dismissed fixed; some fixed and some still open (`shown`, the
 * findings left to act on); else the finding in focus. Findings dismissed in the diff count for none of these.
 */
export function walkLabel(statuses: string[], shown: number[], current: number | null): string {
  if (statuses.includes('fixing')) return 'Applying fixes…';
  const fixed = statuses.filter((st) => st === 'addressed').length;
  if (fixed && !shown.length) return 'Fixes applied';
  if (fixed) return `${fixed} fixed · ${shown.length} open`;
  return current === null ? 'No findings to show' : `Finding ${shown.indexOf(current) + 1} of ${shown.length}`;
}

export function FindingsWalkBar({ chatId }: { chatId: string | null }) {
  const { walk, review, shown, current, latest } = useFindingsWalk(chatId);
  if (!walk || !review) return null;
  const step = (by: number) => focusFinding(shown[(shown.indexOf(current as number) + by + shown.length) % shown.length]);
  const done = review.statuses.every((st) => st !== 'open' && st !== 'fixing');
  return (
    <div className="findings-walk">
      {/* only the label is live: a change of state is read out without the buttons beside it */}
      <span className="findings-walk-label" role="status">
        {walkLabel(review.statuses, shown, current)}
      </span>
      <button className="icon-btn xs" aria-label="Previous finding" disabled={shown.length < 2} onClick={() => step(-1)}>
        <ChevronLeft size={14} />
      </button>
      <button className="icon-btn xs" aria-label="Next finding" disabled={shown.length < 2} onClick={() => step(1)}>
        <ChevronRight size={14} />
      </button>
      <span className="findings-grow" />
      {/* as on the card, only the chat's latest review is run again: a newer one superseded this walk's */}
      {done && latest && (
        <button className="btn-pill ghost findings-action" onClick={() => rerunReview(walk.chatId, review.level)}>
          Re-run review
        </button>
      )}
      <button className="btn-pill ghost findings-action" onClick={() => closeFindingsWalk(walk.chatId)}>
        Dismiss
      </button>
    </div>
  );
}

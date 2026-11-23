// A pull request review thread under its line in the Changes pane: who said what, with a link to it on GitHub; a resolved thread folds to one line until opened, and one GitHub no longer places says so.

import { openUrl } from '../../session/open';
import type { ReviewThread } from '../../lib/prReviewThreads';
import { ChevronDown, ChevronRight, ExternalLink, MessageSquareText } from '../ui/icons';

export function ReviewThreadNote({
  thread,
  focused,
  unfolded,
  onToggle,
}: {
  thread: ReviewThread;
  /** the thread Next unresolved comment went to */
  focused: boolean;
  /** a resolved thread opened by the user */
  unfolded: boolean;
  onToggle: () => void;
}) {
  const first = thread.comments[0];
  const folded = thread.resolved && !unfolded;
  return (
    <div className={`cp-review-thread ${focused ? 'focused' : ''} ${thread.resolved ? 'resolved' : ''}`} data-thread={thread.id}>
      <div className="cp-review-head">
        <MessageSquareText size={13} />
        <span className="cp-review-author">{first.author}</span>
        {thread.line === null && <span className="cp-review-tag">Not on these lines any more</span>}
        {thread.resolved && (
          <button type="button" className="cp-review-tag cp-review-toggle" aria-expanded={!folded} onClick={onToggle}>
            {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />} Resolved
          </button>
        )}
        {folded && <span className="cp-review-snippet">{first.body.split('\n')[0]}</span>}
        {first.url && (
          <button
            type="button"
            className="icon-btn xs"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            onClick={() => openUrl(first.url)}
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      {!folded &&
        thread.comments.map((c, i) => (
          <div key={c.id} className="cp-review-comment">
            {i > 0 && <span className="cp-review-author">{c.author}</span>}
            <p>{c.body}</p>
          </div>
        ))}
    </div>
  );
}

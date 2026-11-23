// A review finding under its line in the Changes pane, as Claude Code's app shows it: who found it, where, what fails, Next, Dismiss and Fix this one.
import type { ReactElement } from 'react';
import { ArrowDown, ArrowUp, CodexMark, X } from '../ui/icons';
import { ClaudeMark } from '../harness/claude/mark';
import { StatusBadge } from '../diff/FindingBadge';
import { categoryLabel, type FindingStatus, type ReviewFinding } from '../../../shared/reviewFindings.mjs';
import type { HarnessId } from '../../harness/types';

/** The reviewing harness's mark and name, as Claude Code's app names itself on its findings ("Claude"). */
const AUTHORS: Record<HarnessId, { Mark: (p: { size: number }) => ReactElement; name: string }> = {
  claude: { Mark: ClaudeMark, name: 'Claude' },
  codex: { Mark: CodexMark, name: 'Codex' },
};

/** "Line 12", or "Lines 4–6" for a range. */
export const lineLabel = (start: number, end: number) => (start === end ? `Line ${end}` : `Lines ${start}–${end}`);

/**
 * `author` names a basic harness that reviewed; a first-tier one shows its mark and short name. Next shows while the finding is open
 * and others are shown; Fix this one while it is open.
 */
export function FindingAnnotation({
  reviewId,
  index,
  finding,
  status,
  current,
  author,
  harness,
  onNext,
  onDismiss,
  onFix,
}: {
  /** the review and the finding's place in it, for the pane to scroll to */
  reviewId: string;
  index: number;
  finding: ReviewFinding;
  status: FindingStatus;
  current: boolean;
  author: string;
  harness: HarnessId | null;
  onNext?: () => void;
  onDismiss: () => void;
  onFix: () => void;
}) {
  const Mark = harness ? AUTHORS[harness].Mark : null;
  const open = status === 'open';
  return (
    <div className="finding-annotation-wrap" data-review={reviewId} data-finding={index}>
      <div tabIndex={-1} aria-current={current || undefined} className={current ? 'finding-annotation current' : 'finding-annotation'}>
        <div className="finding-annotation-head">
          {Mark && <Mark size={16} />}
          <span className="finding-annotation-author">{harness ? AUTHORS[harness].name : author}</span>
          {finding.line ? (
            <span className="finding-annotation-lines">{lineLabel(finding.line, finding.endLine ?? finding.line)}</span>
          ) : null}
          <span className="finding-annotation-badges">
            <StatusBadge finding={finding} status={status} unverified={false} />
            {finding.category && <span className="finding-badge category">{categoryLabel(finding.category)}</span>}
          </span>
          <span className="finding-annotation-tools">
            {open && onNext && (
              <button
                className="icon-btn xs"
                aria-label={finding.line ? `Next finding after the one on line ${finding.line}` : 'Next finding'}
                title="Next finding"
                onClick={onNext}
              >
                <ArrowDown size={14} />
              </button>
            )}
            <button className="icon-btn xs" aria-label="Dismiss finding" title="Dismiss finding" onClick={onDismiss}>
              <X size={14} />
            </button>
          </span>
        </div>
        <div className={open ? 'finding-annotation-body fixable' : 'finding-annotation-body'}>
          <p className="finding-annotation-summary">{finding.summary}</p>
          {finding.failureScenario && <p className="finding-annotation-scenario">{finding.failureScenario}</p>}
        </div>
        {open && (
          <div className="finding-annotation-foot">
            <button className="btn-pill" onClick={onFix}>
              <ArrowUp size={14} /> Fix this one
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

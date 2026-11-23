// The session rail's branch diff link and its current repository totals, for local and Host workspaces.
import { pluralize } from '../../lib/format';
import { openChanges } from '../../store/panes';
import { ChevronRight, DiffSquare } from '../ui/icons';

export type BranchTotals = { files: number; added: number; removed: number; untracked?: number; truncated?: boolean };

export function SummaryBranchChanges({ totals, failed = false }: { totals: BranchTotals | null; failed?: boolean }) {
  return (
    <button type="button" className="summary-row summary-branch-changes" onClick={() => openChanges({ scope: 'branch' })}>
      <DiffSquare size={15} aria-hidden="true" />
      <span className="summary-label">Branch changes</span>
      <span className="summary-change-totals">
        {totals && totals.files > 0 ? (
          <>
            <span className="summary-hint" title={totals.untracked ? "Lines of new files aren't counted" : undefined}>
              {pluralize(totals.files, 'file')}
              {totals.truncated ? '+' : ''}
            </span>
            <span className="diff-stat">
              <span className="plus">+{totals.added}</span> <span className="minus">-{totals.removed}</span>
            </span>
          </>
        ) : (
          <span className="summary-hint">{failed || totals?.truncated ? 'Unavailable' : totals ? 'No changes' : 'Reading…'}</span>
        )}
      </span>
      <ChevronRight size={13} className="summary-next" aria-hidden="true" />
    </button>
  );
}

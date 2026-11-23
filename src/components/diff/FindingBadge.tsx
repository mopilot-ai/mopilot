// A review finding's badge, the same in the review card and in the Changes pane: its status, verdict or category.
import { categoryLabel, type FindingStatus, type ReviewFinding } from '../../../shared/reviewFindings.mjs';

/**
 * Fixed, Fixing…, Dismissed, else its verdict, else its category or Unverified. `unverified` false leaves an open
 * finding with no verdict without a badge (the Changes pane shows its category on its own).
 */
export function StatusBadge({
  finding,
  status,
  unverified = true,
}: {
  finding: ReviewFinding;
  status: FindingStatus;
  unverified?: boolean;
}) {
  if (status === 'addressed') return <span className="finding-badge success">Fixed</span>;
  if (status === 'fixing') return <span className="finding-badge">Fixing…</span>;
  if (status === 'dismissed') return <span className="finding-badge">Dismissed</span>;
  if (finding.verdict === 'CONFIRMED') return <span className="finding-badge danger">Confirmed</span>;
  if (finding.verdict) return <span className="finding-badge warning">Plausible</span>;
  if (!unverified) return null;
  if (finding.category) return <span className="finding-badge category">{categoryLabel(finding.category)}</span>;
  return <span className="finding-badge">Unverified</span>;
}

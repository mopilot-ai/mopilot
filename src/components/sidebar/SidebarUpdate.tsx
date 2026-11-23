// The sidebar's compact update strip: restart/download actions and non-actionable progress above the account button.

import { ArrowRight } from 'lucide-react';
import { native, type UpdateState } from '../../lib/native';
import { useUpdateState } from '../../session/updates';
import { downloadProgress } from '../../lib/updateProgress';
import { Spinner } from '../ui/icons';
import { rollbackAction } from '../../lib/updatePresentation';

/**
 * What the sidebar shows for an update state: nothing while idle, checking or failed (Settings → About says why). A
 * ready update names its action, a queued restart, or a retry; full version and failure detail stays in the tooltip.
 */
export function updateLabel(st: UpdateState): string | null {
  switch (st.status) {
    case 'ready':
      if (!st.available) return null;
      if (st.manual) return rollbackAction(st) ?? 'Download update';
      if (st.restartWhenIdle) return 'Restarting when idle';
      return st.error
        ? st.available.rollback
          ? 'Retry rollback'
          : 'Restart to retry update'
        : (rollbackAction(st) ?? 'Restart to update');
    case 'downloading': {
      if (st.preparing) return 'Preparing update';
      const percent = downloadProgress(st)?.percent;
      return percent == null ? 'Downloading update' : `Downloading update · ${percent}%`;
    }
    case 'installing':
      return 'Restarting to update';
    default:
      return null;
  }
}

/** Ready: a row that restarts to update (Windows: downloads the installer). Otherwise a busy, unclickable status. */
export function SidebarUpdate() {
  const st = useUpdateState();
  const label = updateLabel(st);
  if (!label) return null;
  const ready = st.status === 'ready';
  const version = st.status === 'downloading' ? st.progress?.version : st.available?.version;
  const title = [label, version && `v${version}`, st.error].filter(Boolean).join(' · ');
  const content = (
    <>
      {!ready && (
        <span className="sidebar-update-spinner" aria-hidden="true">
          <Spinner size={12} />
        </span>
      )}
      <span className="sidebar-update-label">{label}</span>
      {ready && <ArrowRight className="sidebar-update-arrow" size={14} aria-hidden="true" />}
    </>
  );
  return ready ? (
    <button
      type="button"
      className="sidebar-update"
      aria-label={label}
      title={title}
      onClick={() => (st.manual ? native.updates.install() : native.updates.install({ when: 'now' }))}
    >
      {content}
    </button>
  ) : (
    <span
      className="sidebar-update busy"
      role="progressbar"
      tabIndex={0}
      aria-label={label}
      title={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={st.preparing ? undefined : (downloadProgress(st)?.percent ?? undefined)}
    >
      {content}
    </span>
  );
}

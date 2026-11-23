// The sidebar's Computer History row above the account button (#1363): while it is on, a dot and its status (recording, paused, stopped or what it needs) that opens Settings → Computer History; nothing while it is off.
import { useComputerHistoryStatus, SHORT_LABEL } from '../../store/computerHistory';
import { navigate } from '../../store/panes';

export function SidebarHistory() {
  const status = useComputerHistoryStatus();
  if (!status) return null;
  const label = `Computer History · ${SHORT_LABEL[status]}`;
  return (
    <button
      type="button"
      className="side-row sidebar-history"
      data-status={status}
      aria-label={label}
      title="Manage Computer History"
      onClick={() => navigate({ name: 'settings', section: 'computer-history' })}
    >
      <span className="side-row-icon">
        <span className="sidebar-history-dot" />
      </span>
      <span className="side-row-label">{label}</span>
    </button>
  );
}

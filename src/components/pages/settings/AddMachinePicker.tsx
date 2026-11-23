// The machines the Add machine sheet offers: found when it opens (this network over Bonjour, Tailscale peers, the ssh config), only the sources its tab shows, filtered by what is typed; picking one starts adding it, one already in My machines says Added, and a Mac with Remote Login off says so.
import { useEffect, useState, type ReactNode } from 'react';
import { native } from '../../../lib/native';
import type { HostFoundMachine } from '../../../lib/native/host';
import { Spinner } from '../../ui/icons';

const GROUPS: { source: HostFoundMachine['source']; title: string }[] = [
  { source: 'network', title: 'On your network' },
  { source: 'tailscale', title: 'Tailscale' },
  { source: 'config', title: 'SSH config' },
];

/** The machines to offer, looked for once each time the picker opens (never before: discovery touches the network). */
function useFound(open: boolean) {
  const [found, setFound] = useState<HostFoundMachine[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFound(null);
    native.host
      .discover()
      .then((rows) => live && setFound(rows))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, [open]);
  return found;
}

export function AddMachinePicker({
  open,
  filter,
  sources,
  empty,
  onPick,
}: {
  open: boolean;
  filter: string;
  sources: readonly HostFoundMachine['source'][];
  /** what to say when nothing was found (and nothing is typed); nothing by default */
  empty?: ReactNode;
  onPick: (m: HostFoundMachine) => void;
}) {
  const found = useFound(open);
  if (!open) return null;
  const q = filter.trim().toLowerCase();
  const shown = (found ?? []).filter(
    (m) => sources.includes(m.source) && (!q || `${m.name} ${m.detail} ${m.destination}`.toLowerCase().includes(q)),
  );
  return (
    <div className="add-machine-picker" role="listbox" aria-label="Machines found">
      {found === null && (
        <div className="add-machine-picker-status" role="status">
          <Spinner size={12} /> Looking for machines…
        </div>
      )}
      {found !== null && shown.length === 0 && !q && empty && (
        <div className="add-machine-picker-status" role="status">
          {empty}
        </div>
      )}
      {GROUPS.map((g) => {
        const rows = shown.filter((m) => m.source === g.source);
        if (!rows.length) return null;
        return (
          <div key={g.source} className="add-machine-picker-group">
            {sources.length > 1 && <div className="add-machine-picker-title">{g.title}</div>}
            {rows.map((m) => (
              <button
                key={`${m.source}:${m.destination}`}
                type="button"
                role="option"
                aria-selected={false}
                className="add-machine-picker-row"
                title={m.destination}
                disabled={m.added}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(m)}
              >
                <span className="add-machine-picker-text">
                  <span className="add-machine-picker-name">{m.name}</span>
                  <span className="add-machine-picker-detail">
                    {m.remoteLoginOff && <span className="machine-dot warn" aria-hidden="true" />}
                    {m.detail}
                  </span>
                </span>
                <span className={m.added ? 'add-machine-picker-added' : 'btn-pill soft small'}>{m.added ? 'Added' : 'Add'}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

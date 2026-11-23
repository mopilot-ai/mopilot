// Stands where the permission picker does in a chat that runs on a machine: its permission mode is the machine's, so the chip is there but cannot be opened.
import { Lock } from 'lucide-react';
import { Tooltip } from '../ui/Popover';

export function HostModeChip({ machine }: { machine: string }) {
  return (
    <Tooltip label={`Permissions are set on ${machine}`}>
      <button className="host-mode-chip" disabled aria-label={`Permissions are set on ${machine}`}>
        <Lock size={14} strokeWidth={1.8} />
        <span>Set on {machine}</span>
      </button>
    </Tooltip>
  );
}

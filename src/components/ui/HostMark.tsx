// Execution location glyphs for sessions and projects.
import { hostLocationKind, type HostLocationKind } from '../../lib/hostLocation';
import type { HostMachineRow } from '../../lib/hostMachines';
import { onMachineHint } from '../../lib/machineFolder';
import { Cloud, Laptop, Layers, Monitor, SquareTerminal } from './icons';

const ICONS = { background: Laptop, cloud: Cloud, mixed: Layers, remote: Monitor, ssh: SquareTerminal };

export function HostMark({ id, name = id, cloud, size }: { id: string; name?: string; cloud?: HostMachineRow['cloud']; size?: number }) {
  return <LocationMark kind={hostLocationKind(id, cloud)} label={onMachineHint(name)} size={size} />;
}

export function LocationMark({ kind, label, size = 14 }: { kind: HostLocationKind | 'mixed'; label?: string; size?: number }) {
  const Icon = ICONS[kind];
  return (
    <span className="host-mark" role={label === undefined ? undefined : 'img'} aria-label={label} title={label}>
      <Icon aria-hidden="true" size={size} strokeWidth={1.7} />
    </span>
  );
}

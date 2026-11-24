// A machine's Details dialog (its ⋯ menu): the machine's name, where this Mac reaches it, its system, the version of its Host and when it last answered, read only.
import { Modal } from '../../ui/Modal';
import { seenAgo } from '../../../lib/machineStatus';
import type { HostMachineRow } from '../../../lib/hostMachines';

const SYSTEM = { darwin: 'macOS', linux: 'Linux', '': '' } as const;

/** The fields Details shows, in order, each with its words: a field the machine never told is left out. */
export function machineDetails(machine: HostMachineRow, now: number): { label: string; value: string }[] {
  const online = machine.status !== 'offline';
  const seen = online ? 'Just now' : machine.lastSeen === null ? '' : seenAgo(machine.lastSeen, now);
  return [
    { label: 'Host', value: machine.address ?? '' },
    { label: 'System', value: SYSTEM[machine.platform] },
    { label: 'Version', value: machine.hostVersion ?? '' },
    { label: 'Last seen', value: seen },
  ].filter((f) => f.value);
}

export function MachineDetails({ machine, now, onClose }: { machine: HostMachineRow; now: number; onClose: () => void }) {
  const online = machine.status !== 'offline';
  return (
    <Modal title={machine.name} onClose={onClose}>
      <div className="machine-sheet">
        <span className={`machine-badge ${online ? 'ok' : 'off'}`}>{online ? 'Connected' : 'Offline'}</span>
        <dl className="machine-details">
          {machineDetails(machine, now).map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

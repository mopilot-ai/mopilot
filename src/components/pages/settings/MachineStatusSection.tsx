// A machine page's Status: the machine's one status line, how this Mac reaches it (Direct, Relay · 80 ms, SSH) with the choice of path, and the Host's version with Update when it is out of date.
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import type { HostMachineRow } from '../../../lib/hostMachines';
import type { HostPathMode } from '../../../lib/native/host';
import { machineStatus } from '../../../lib/machineStatus';
import { userError } from '../../../../shared/userError.mjs';
import { Group, Row, Select } from './Controls';
import { startInstall } from '../../../lib/hostInstall';
import { ActionButton, SigninRunning, currentSignin } from './MachineAgentActions';
import { UpdateButton } from '../../host/UpdateButton';
import { RUNNING, useHostSignins } from '../../../lib/hostSignin';

/** "Direct" when it goes straight there, "Relay · 80 ms", "SSH"; nothing when this Mac has not said. */
export function reachLine(path: HostMachineRow['path']): string | null {
  if (!path?.path) return null;
  if (path.path === 'ssh') return 'SSH';
  return path.latencyMs === null ? 'Relay' : `Relay · ${Math.round(path.latencyMs)} ms`;
}

const MODES: { value: HostPathMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'ssh', label: 'SSH' },
  { value: 'relay', label: 'Relay' },
];

export function MachineStatusSection({ machine, now }: { machine: HostMachineRow; now: number }) {
  // the sign-in under way (or the last that ended) speaks in the line and shows its code field, Open page and Cancel, as in the machine's row
  const signins = useHostSignins();
  const signin = machine.status !== 'offline' ? currentSignin(machine.id, machine.agents, signins) : null;
  const running = signin && RUNNING.has(signin.view.state) ? signin : null;
  const line = machineStatus(machine, { now, signin, installing: undefined });
  const reach = reachLine(machine.path);
  return (
    <Group title="Status">
      <Row title={line.text} desc={line.title}>
        <span className={`machine-dot ${line.dot}`} aria-hidden="true" />
        {/* a sign-in the line speaks of starts from here; an install stays the row's */}
        {running ? (
          <SigninRunning machine={machine} agent={running.agent} view={running.view} />
        ) : (
          line.action?.kind === 'signin' && <ActionButton machine={machine} action={line.action} onInstall={startInstall} />
        )}
      </Row>
      {machine.path && (
        <Row title="Connection" desc={reach ?? undefined}>
          <Select
            label="Connection"
            value={machine.path.mode}
            options={MODES}
            onChange={(mode) => void native.host.setPath(machine.id, mode).catch((e) => toast(userError(e), 'error'))}
          />
        </Row>
      )}
      {line.update && (
        <Row title="Host">
          <UpdateButton machine={machine} label={line.update.label} />
        </Row>
      )}
    </Group>
  );
}

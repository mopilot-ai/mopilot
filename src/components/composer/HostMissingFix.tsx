// The fix in place under a missing agent's row in the machine picker, so no row is a dead end: Install on the machine when its Host installs the agent, else Update when the Host is too old to, else the vendor's own command (InstallByHand) with Open terminal for a machine reached over ssh.
import { HostInstallRow, useHostInstall } from './hostInstall';
import { HostUpdateAction } from '../host/HostUpdateAction';
import { InstallByHand } from '../host/InstallByHand';
import { MenuRow } from '../ui/MenuList';
import { set } from '../../store/core';
import { hostUpdateLine } from '../../lib/machineStatus';
import { sshTargetOf } from '../../lib/machineShell';
import type { HostMachineRow } from '../../lib/hostMachines';

export function HostMissingFix({
  machine,
  agentId,
  label,
  onTerminal,
}: {
  machine: HostMachineRow;
  agentId: string;
  label: string;
  onTerminal: () => void;
}) {
  const install = useHostInstall(machine, agentId);
  // the Host installs it itself: the row's Install / Cancel / Retry
  if (install) return <HostInstallRow machine={machine} agentId={agentId} />;
  // a Host older than this app cannot (it reports nothing installable): the machine row's own Update
  if (hostUpdateLine(machine)?.update) return <HostUpdateAction hostId={machine.id} text="Update the Host" />;
  const target = sshTargetOf(machine.id);
  return (
    <>
      <InstallByHand machine={machine} agent={agentId} label={label} />
      {target && (
        <span className="hp-actions">
          <MenuRow
            bare
            className="hp-mini"
            aria-disabled={false}
            onClick={() => {
              onTerminal();
              // the bottom terminal panel, as a chat on a machine opens it (#5046): a shell on this machine in the chat's folder, from a new chat or a started one
              set({ bottomPanelOpen: true });
            }}
          >
            Open terminal
          </MenuRow>
        </span>
      )}
    </>
  );
}

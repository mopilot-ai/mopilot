// The Install action of an agent a machine lacks, shared by the note above a new chat's composer and the machine picker's agent rows: one click starts the Host's own install, and the same control cancels or retries it.
import { INSTALLING, cancelInstall, installKey, installLine, startInstall, useHostInstalls } from '../../lib/hostInstall';
import { toast } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';
import type { HostMachineRow } from '../../lib/hostMachines';
import { MenuRow } from '../ui/MenuList';

/** @returns null unless the agent is one the machine's Host installs itself; else its progress line (or '') and the button's words and click. */
export function useHostInstall(machine: HostMachineRow | null | undefined, agentId: string | undefined) {
  const installs = useHostInstalls();
  if (!machine || !agentId || !machine.installable?.includes(agentId)) return null;
  const progress = installs.get(installKey(machine.id, agentId));
  const installing = !!progress && INSTALLING.has(progress.state);
  const label = installing
    ? 'Cancel'
    : progress?.state === 'failed' || progress?.state === 'unreachable'
      ? 'Retry'
      : `Install on ${machine.name}`;
  const act = () =>
    void (installing ? cancelInstall(machine.id, agentId) : startInstall(machine.id, agentId)).catch((e) => toast(userError(e), 'error'));
  return { line: installLine(progress), label, act };
}

/** A missing agent's row action in the machine picker: the progress line while it installs, and the same Install / Cancel / Retry as the new-chat note. */
export function HostInstallRow({ machine, agentId }: { machine: HostMachineRow; agentId: string }) {
  const install = useHostInstall(machine, agentId);
  if (!install) return null;
  return (
    <>
      {install.line && <span className="menu-desc">{install.line}</span>}
      <span className="hp-actions">
        <MenuRow bare className="hp-mini primary" aria-disabled={false} onClick={install.act}>
          {install.label}
        </MenuRow>
      </span>
    </>
  );
}

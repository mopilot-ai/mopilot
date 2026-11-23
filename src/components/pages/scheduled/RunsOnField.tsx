// The Scheduled dialog's "Runs on": this Mac or one of the user's machines (the composer's machine list), the folder a run uses there, and how a run there gets its sign-in.
import { useState } from 'react';
import { HostFolderPicker } from '../../composer/HostFolderPicker';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { THIS_MAC, machineCredential, machineHint, machineWhere, ownSignIn } from '../../../lib/scheduleMachine';
import type { RunWith } from '../../../lib/scheduleTask';
import { SchedSelect } from './controls';
import { basename } from '../../../lib/paths';

export function RunsOnField({
  machines,
  runsOn,
  folder,
  harness,
  harnessLabel,
  onRunsOn,
  onFolder,
}: {
  machines: HostMachineRow[];
  /** THIS_MAC or a machine's id */
  runsOn: string;
  /** the machine's folder a run uses ('' before one is picked) */
  folder: string;
  harness: RunWith;
  harnessLabel: string;
  onRunsOn: (id: string) => void;
  onFolder: (path: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const machine = machines.find((m) => m.id === runsOn);
  // a machine that left the list stays the task's, named by its id, until the user picks another
  const options = [
    { value: THIS_MAC, label: 'This Mac' },
    ...machines.map((m) => ({ value: m.id, label: m.name, hint: machineHint(m) })),
    ...(runsOn !== THIS_MAC && !machine ? [{ value: runsOn, label: runsOn, hint: 'Not in your list' }] : []),
  ];
  const credential = runsOn === THIS_MAC ? null : machineCredential(machine, harness, harnessLabel);
  return (
    <>
      <div className="sched-field">
        <span>Runs on</span>
        <SchedSelect label="Runs on" value={runsOn} options={options} onChange={onRunsOn} />
      </div>
      {runsOn !== THIS_MAC && (
        <>
          <div className="sched-field">
            <span>Folder</span>
            <button className="sched-select" aria-label="Folder on the machine" onClick={() => setPicking(true)} disabled={!machine}>
              <span>{folder ? basename(folder) : 'Choose…'}</span>
            </button>
          </div>
          {credential && (
            <div
              className={`sched-field sched-where-note${credential.tone === 'warn' ? ' warn' : ''}`}
              data-testid="sched-machine-credential"
            >
              {credential.text}
            </div>
          )}
          {machine && <div className="sched-field sched-where-note">{machineWhere(machine.name, ownSignIn(machine, harness))}</div>}
          {picking && machine && (
            <HostFolderPicker
              hostId={machine.id}
              name={machine.name}
              onPick={(path) => {
                onFolder(path);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </>
      )}
    </>
  );
}

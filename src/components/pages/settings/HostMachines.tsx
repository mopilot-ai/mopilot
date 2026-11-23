// Settings › Connections › Machines: the machines Host can run chats on, one row each (MachineRow), an Add machine button that opens the one Add machine sheet (AddMachineDialog), and the Sign-in section (how machines sign in, Sign out everywhere).
import { useEffect, useState } from 'react';
import { useHostAccess } from '../../../lib/host';
import { useHostMachines } from '../../../lib/hostMachines';
import { useHostSignins } from '../../../lib/hostSignin';
import { useGitSignIn } from '../../../lib/hostGitSignIn';
import { installAndWait, useHostInstalls } from '../../../lib/hostInstall';
import { PendingChatDeletions } from './PendingChatDeletions';
import { visiblePoll } from '../../../lib/visiblePoll';
import { MachineRow } from './MachineRow';
import { openAddMachine } from '../../../lib/addMachine';
import { HostSigninMethod } from './HostSigninMethod';
import { HostRotateKey } from './HostRotateKey';
import type { InstallAgent } from './MachineAgentActions';

/** The clock "seen 2 h ago" is told from, moved each minute while the window shows. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => visiblePoll('host-machines-clock', 60_000, () => setNow(Date.now())), []);
  return now;
}

/** `onInstall`: installs a missing Claude Code or Codex on a machine; by default the machine's Host installs it itself (the one-click install, src/lib/hostInstall.ts). */
export function HostMachines({ onInstall = installAndWait }: { onInstall?: InstallAgent }) {
  const allowed = useHostAccess();
  const installs = useHostInstalls();
  const { machines } = useHostMachines();
  const signins = useHostSignins();
  const gitSignIns = useGitSignIn(machines);
  const now = useMinuteClock();
  if (!allowed) return null;
  return (
    <section className="settings-group machines-page" aria-label="Machines">
      <div className="machines-head">
        <div>
          <h2 className="settings-group-title">Machines</h2>
          <div className="settings-group-desc">Run chats on your other computers.</div>
        </div>
        <button className="btn-pill primary" onClick={openAddMachine}>
          Add machine
        </button>
      </div>
      <div className="machine-list" aria-label="My machines">
        {machines.length === 0 ? (
          <div className="machine-empty">No machines yet.</div>
        ) : (
          machines.map((m) => (
            <MachineRow
              key={m.id}
              machine={m}
              signins={signins}
              installs={installs}
              onInstall={onInstall}
              now={now}
              gitSignIn={gitSignIns.get(m.id)}
            />
          ))
        )}
      </div>
      <PendingChatDeletions />
      <HostSigninMethod />
      <HostRotateKey machines={machines} />
    </section>
  );
}

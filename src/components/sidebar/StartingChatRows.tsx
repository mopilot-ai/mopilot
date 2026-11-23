// Sidebar rows for accepted submissions that are still preparing their folder or native session.
import type { ChatStart } from '../../lib/chatStarts';
import { useHostMachines } from '../../lib/hostMachines';
import { onMachineHint } from '../../lib/machineFolder';
import { HostMark } from '../ui/HostMark';
import { RowDot } from './ThreadIndicators';

export function StartingChatRows({
  entries,
  indent = true,
  projectHostId,
}: {
  entries: readonly ChatStart[];
  indent?: boolean;
  projectHostId?: string;
}) {
  if (entries.length === 0) return null;
  return <StartingRows entries={entries} indent={indent} projectHostId={projectHostId} />;
}

function StartingRows({ entries, indent, projectHostId }: { entries: readonly ChatStart[]; indent: boolean; projectHostId?: string }) {
  const { machines } = useHostMachines();
  return entries.map((entry) => {
    const machine = machines.find((m) => m.id === entry.hostId);
    const machineName = entry.hostId ? (machine?.name ?? entry.hostId) : undefined;
    return (
      <div
        key={entry.id}
        className={`side-row thread-row ${indent ? 'indent' : ''}`}
        data-chat-start={entry.id}
        role="status"
        aria-label={`${entry.name} · Starting chat`}
        aria-description={machineName === undefined ? undefined : onMachineHint(machineName)}
        aria-busy="true"
        title="Starting chat"
      >
        <span className="thread-row-content">
          <span className="side-row-label">{entry.name}</span>
        </span>
        {entry.hostId && entry.hostId !== projectHostId && <HostMark id={entry.hostId} name={machine?.name} cloud={machine?.cloud} />}
        <RowDot status="working" label="Starting chat" />
      </div>
    );
  });
}

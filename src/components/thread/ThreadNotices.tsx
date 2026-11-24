// The notes under a chat's last turn for the harness's MCP servers and the machine's Host update status.
import { OwnMcpNotice } from '../harness/OwnMcp';
import { UpdateButton } from '../host/UpdateButton';
import { MachineNotice } from '../panels/MachineFolderNote';
import { useChatMachine } from '../../lib/chatMachine';
import { hostUpdateLine } from '../../lib/machineStatus';

export function HostOutdatedNotice({ threadId }: { threadId: string }) {
  const { machine } = useChatMachine(threadId);
  const row = machine?.row;
  if (!row?.hostStale || row.hostDiffers) return null;
  const line = hostUpdateLine(row);
  return (
    line && (
      <MachineNotice text={`${row.name} · ${line.text}`} title={line.title}>
        {line.update && <UpdateButton key={row.id} machine={row} label={line.update.label} />}
      </MachineNotice>
    )
  );
}

export function ThreadNotices({ threadId }: { threadId: string }) {
  return (
    <>
      <OwnMcpNotice threadId={threadId} />
      <HostOutdatedNotice threadId={threadId} />
    </>
  );
}

// The notes under a chat's last turn: the harness's own MCP servers that crowd the model, and a chat on a machine whose Host is older than this app (it can miss replies, so the person is told, with the machine row's Update in place).
import { OwnMcpNotice } from '../harness/OwnMcp';
import { MachineNotice } from '../panels/MachineFolderNote';
import { useChatMachine } from '../../lib/chatMachine';

/** What a chat says about its machine's Host: nothing unless the Host is older than this app. The sentence asks for the update, so the row's own Update button follows it (HostUpdateAction). */
export function HostOutdatedNotice({ threadId }: { threadId: string }) {
  const { machine } = useChatMachine(threadId);
  if (!machine?.row?.hostStale || machine.away) return null;
  return <MachineNotice text={`${machine.name}'s Host is out of date, so replies may not show. Update it.`} hostId={machine.id} />;
}

export function ThreadNotices({ threadId }: { threadId: string }) {
  return (
    <>
      <OwnMcpNotice threadId={threadId} />
      <HostOutdatedNotice threadId={threadId} />
    </>
  );
}

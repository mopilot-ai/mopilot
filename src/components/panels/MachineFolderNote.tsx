// What a panel says in place of a folder's git, branch or files when the chat's folder is on a machine: this Mac holds no copy of it, so nothing is read here.
import { Server } from '../ui/icons';
import { HostUpdateAction } from '../host/HostUpdateAction';
import type { ChatMachine } from '../../lib/chatMachine';

/** @param what the panel's subject in the sentence ("Changes", "Files") */
export function MachineFolderNote({ machine, what }: { machine: ChatMachine; what: string }) {
  return (
    <div className="machine-folder-note" role="status">
      <Server size={16} strokeWidth={1.7} aria-hidden="true" />
      <span>
        {what} {machine.away ? `aren't available while ${machine.name} is offline` : `aren't shown for a folder on ${machine.name}`}.
      </span>
    </div>
  );
}

/** One line from the machine's Host about why a panel has nothing to show (a refusal, an older Host). */
export function MachineNotice({ text, hostId }: { text: string; hostId?: string }) {
  return (
    <div className="machine-folder-note" role="status">
      <Server size={16} strokeWidth={1.7} aria-hidden="true" />
      <span>{text}</span>
      {hostId && <HostUpdateAction hostId={hostId} text={text} />}
    </div>
  );
}

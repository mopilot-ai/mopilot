// Machine status and refusal notes for threads and panels, including folders unavailable on this Mac.
import type { ReactNode } from 'react';
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

/** A machine status or refusal, with the relevant action beside it. */
export function MachineNotice({ text, hostId, title, children }: { text: string; hostId?: string; title?: string; children?: ReactNode }) {
  return (
    <div className="machine-folder-note" role="status" title={title} aria-description={title}>
      <Server size={16} strokeWidth={1.7} aria-hidden="true" />
      <span>{text}</span>
      {hostId && <HostUpdateAction hostId={hostId} text={text} />}
      {children}
    </div>
  );
}

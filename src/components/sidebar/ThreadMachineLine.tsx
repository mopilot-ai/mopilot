// A sidebar chat's Host location and the attention state the row shows when it needs a second line.
import { useChatMachine } from '../../lib/chatMachine';
import { useChatAttention } from '../../lib/chatAttention';
import { useFlag } from '../../lib/flags';
import { attentionLine } from '../../../shared/host/attentionLine.mjs';

/** The machine is useful independently of unattended attention states. */
export function useRowMachineLine(threadId: string) {
  const on = useFlag('host.unattended');
  const { machine } = useChatMachine(threadId);
  const attention = useChatAttention(threadId);
  if (!machine) return null;
  const word = on ? attentionLine({ attention, machineName: machine.name, machine: machine.away ? 'offline' : 'online' }).row : null;
  return { id: machine.id, name: machine.name, cloud: machine.row?.cloud, word };
}

export function ThreadMachineLine({ word }: { word: string }) {
  return <span className="side-row-sub">{word}</span>;
}

// The Changes pane of a chat on a machine: the same pane as this Mac's, run on the machine's source (its Host reads the patch and does the commit and discard) in the chat's own folder there.
import type { ChatMachine } from '../../lib/chatMachine';
import { useMachineChangesSource } from '../../lib/machineChangesSource';
import { useStore } from '../../store/core';
import { DiffPanel } from './DiffPanel';

export function MachineChanges({ machine, threadId }: { machine: ChatMachine; threadId: string | null }) {
  // the folder on the machine is the chat's own
  const folder = useStore((s) => (threadId ? (s.threads[threadId]?.cwd ?? '') : ''));
  const source = useMachineChangesSource({ id: machine.id, name: machine.name, stale: machine.row?.hostStale }, folder);
  return <DiffPanel cwd={folder} threadId={threadId} source={source} />;
}

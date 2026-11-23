// Resolves the composer's draft or started-chat machine before offering features that only work on this Mac.
import { useChatMachine } from '../lib/chatMachine';
import { useStore } from '../store/core';
import { newChatHostPick } from '../store/projects';

export function useComposerLocation(threadId: string | null): { machine: string | null; machineId?: string; pending: boolean } {
  const { machine, pending } = useChatMachine(threadId);
  const draft = useStore((s) => (threadId ? null : newChatHostPick(s)));
  return threadId
    ? { machine: machine?.name ?? null, ...(machine?.id ? { machineId: machine.id } : {}), pending }
    : { machine: draft?.name ?? null, ...(draft?.id ? { machineId: draft.id } : {}), pending: false };
}

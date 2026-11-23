// Where a chat's folder is: this Mac, or a machine (Host). Panels that read the folder with this Mac's git or files take the folder from here, so a machine's path is never looked up on this Mac. Fed by one shared read of every chat on a machine (hostChats.ts), not one read per chat.
import { useMemo } from 'react';
import { machineOfChat, useHostChats } from './hostChats';
import { useHostMachines, type HostMachineRow } from './hostMachines';
import { agentOfKind, hostFamilyOfHarness } from '../../shared/host/chatIds.mjs';
import { machineFolderKey } from './machineFolder';

/** The machine a chat runs on; `away` while it is offline; `row` is its entry in the registry (what the machine's own row in Settings says), absent for a machine that is not listed any more. */
export type ChatMachine = { id: string; name: string; away: boolean; row?: HostMachineRow };

/**
 * The machine the chat runs on, null for this Mac. `pending` until main has said which chats run on machines: nothing may read the folder on this Mac meanwhile.
 * A machine that is not listed any more still holds the chat (its id stands for its name). A failed read says nothing about the chat: it is taken as this Mac's and read again.
 */
export function useChatMachine(threadId: string | null): { machine: ChatMachine | null; pending: boolean } {
  const state = useHostChats();
  const { machines } = useHostMachines();
  const id = machineOfChat(state, threadId);
  if (id === null) return { machine: null, pending: true };
  if (id === '') return { machine: null, pending: false };
  const row = machines.find((m) => m.id === id);
  return { machine: { id, name: row?.name ?? id, away: row?.status === 'offline', ...(row && { row }) }, pending: false };
}

/** The chat's folder when it is on this Mac, else '': a folder on a machine, or one whose machine is not known yet, is read nowhere here. */
export function useLocalFolder(threadId: string | null, cwd: string): { cwd: string; machine: ChatMachine | null; pending: boolean } {
  const { machine, pending } = useChatMachine(threadId);
  return { cwd: machine || pending ? '' : cwd, machine, pending };
}

/** The folder a reader on this Mac may look in for a chat, '' for one on a machine or one not known yet: the one gate for rows and menus that only need the folder (every chat of a list asks, one shared read answers). */
export function useFolderHere(chatId: string | null, cwd: string): string {
  return machineOfChat(useHostChats(), chatId) === '' ? cwd : '';
}

/**
 * What the chat's links read from `RemoteFolderContext`: the machine for a chat on one, nothing on this Mac, and an empty machine id while the chat's machine is not known yet (its links neither look anything up here nor open anything until it is). Stable while the answer is.
 */
export function useRemoteFolderValue(threadId: string | null, folder: string): { machineId: string; folder: string } | null {
  const { machine, pending } = useChatMachine(threadId);
  const machineId = machine ? machine.id : pending ? '' : null;
  return useMemo(() => (machineId === null ? null : { machineId, folder }), [machineId, folder]);
}

/** The folder a PR read goes by for a chat: its folder on this Mac, its machine's folder as a machine key (the reader asks that machine's Host for the branch), '' while that is not known, for a machine that is offline, or for a chat with no folder. */
export function usePullRequestFolder(threadId: string | null, cwd: string): string {
  const { machine, pending } = useChatMachine(threadId);
  if (pending || !cwd) return '';
  if (!machine) return cwd;
  return machine.away ? '' : machineFolderKey(machine.id, cwd);
}

/**
 * Whether a chat on a machine runs another agent there than the one its id names (a switch settled, `hostAgent` is the agent the Host last said): its id, and so the session id a CLI resumes by, is the first agent's.
 * @param chatId the chat's id on this Mac (`acp:host-claude:<uuid>`) @param hostAgent the wire's harness id kept in the chat's config
 */
export function movedOnMachine(chatId: string, hostAgent: string | null | undefined): boolean {
  const agent = agentOfKind(hostAgent);
  const named = /^acp:([^:]+):/.exec(chatId)?.[1];
  // a chat that is no ACP chat names no agent a machine could have moved it from
  return agent !== null && named !== undefined && agent !== (hostFamilyOfHarness(named) ?? named);
}

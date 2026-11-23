// The `/` menu's source for a chat on a machine (#4915): the machine, the agent the chat runs there and its folder, and what that agent lists on the machine (the Host's `host.commands`). The same for a chat that exists and for the new chat a machine is picked for, so both ask the machine, never this Mac's own commands and skills. Null for a chat on this Mac.
import { useStore } from '../store/core';
import { chatBasicHarness } from '../store/chats';
import { agentOfKind } from '../store/machineChatSwitch';
import { hostFamilyOfHarness, isHostFamily } from '../../shared/host/chatIds.mjs';
import { useChatMachine } from '../lib/chatMachine';
import { useHostCommands, type CommandsAnswer } from '../lib/hostCommands';
import { useHostAgentChoice } from './useHostAgentChoice';

/** What the machine's agent lists, and where. */
export type MachineCommands = { machine: { id: string; name: string }; answer: CommandsAnswer | { state: 'loading' } | null };

/** The id the Host lists an agent's commands by: Claude Code and Codex by name. Any other agent has none to ask for: its commands come on its own session (`available_commands_update`), which a chat on a machine does not mirror yet, so it is not asked (null). */
export const wireHarnessOf = (agent: string) => (isHostFamily(agent) ? agent : null);

/** What an agent the Host cannot list for says: nothing listed, and nothing asked. */
const NOT_LISTED: CommandsAnswer = { state: 'ready', listed: false, commands: [] };

/** @param threadId the chat, or null for the new chat @param want whether the menu is open: the machine is asked only then */
export function useMachineCommands(threadId: string | null, want: boolean): MachineCommands | null {
  const { machine } = useChatMachine(threadId);
  const draft = useHostAgentChoice();
  // the agent a chat on a machine runs on there: the one the Host moved it to, else the one its id names
  const chatAgent = useStore((s) => {
    if (!threadId) return '';
    const basic = chatBasicHarness(threadId, s) ?? '';
    return agentOfKind(s.chatConfig?.[threadId]?.hostAgent) ?? hostFamilyOfHarness(basic) ?? basic;
  });
  const folder = useStore((s) => (threadId ? (s.threads[threadId]?.cwd ?? '') : (s.newChatHost?.path ?? '')));
  const target = threadId
    ? machine && chatAgent
      ? { id: machine.id, name: machine.name, agent: chatAgent }
      : null
    : draft && (draft.choice?.harness ?? draft.want)
      ? { id: draft.pick.id, name: draft.pick.name, agent: draft.choice?.harness ?? draft.want }
      : null;
  const wire = target ? wireHarnessOf(target.agent) : null;
  const answer = useHostCommands(target?.id ?? null, wire, folder, want, threadId ?? '');
  return target ? { machine: { id: target.id, name: target.name }, answer: wire ? answer : NOT_LISTED } : null;
}

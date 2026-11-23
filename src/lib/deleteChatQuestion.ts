// The question before a chat is deleted for good, and for a chat on a machine what that does there and what the machine's agent keeps of its own.
import { hostChatId } from '../../shared/host/chatIds.mjs';

/**
 * Where a delete goes besides this Mac, as the question names it: the machine as its row writes the name, "its machine" for one this window cannot name yet or any more, null for a chat of this Mac. A chat whose owner is not read yet, or whose id is a machine's own, is on a machine.
 * @param machine the chat's machine as `useChatMachine` has it (a row is present while the machine is listed)
 * @param pending the chats' machines have not been read yet
 */
export function deleteMachineName(chatId: string, machine: { name: string; row?: unknown } | null, pending: boolean): string | null {
  if (machine) return machine.row ? machine.name : 'its machine';
  return pending || hostChatId(chatId) !== chatId ? 'its machine' : null;
}

/** What an agent keeps on the machine after the Host's delete, by the agent the chat runs on now: Claude Code's session goes with its transcript; Codex's own database is Codex's; another agent has no delete over ACP. */
const KEPT: Record<string, string> = {
  claude: '',
  codex: ' Codex may keep a copy.',
};
const OTHER_AGENT = ' The agent keeps its own history.';

/**
 * @param machine where the chat runs as the person knows it, or null for this Mac
 * @param agent the agent the chat runs on now (`hostAgentOf`): 'claude', 'codex' or a basic agent's id
 */
export function deleteChatQuestion(machine: string | null, agent: string): string {
  if (machine === null) return 'Permanently delete this chat? This cannot be undone.';
  return `Permanently delete this chat here and on ${machine}? This cannot be undone.${Object.hasOwn(KEPT, agent) ? KEPT[agent] : OTHER_AGENT}`;
}

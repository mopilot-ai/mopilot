// Moving a chat on a machine to another agent there (D13): the Host holds the choice until the chat's next message, and the composer's switch chip shows it from the session store, as for a chat on this Mac. A refusal comes back as one short line, never a silent no-op.
import { native } from '../lib/native';
import { ignoring } from '../lib/ignored';
import { agentOfKind, isHostFamily } from '../../shared/host/chatIds.mjs';
import { hostAgentOf } from './hostAgent';
import { setSession } from './session/useSession';
import { onMachineNow } from '../lib/hostChats';
import type { HarnessKind } from '../harness/adapter';
import type { HarnessId } from '../harness/types';

/** The agent a machine lists by `id` ('claude', 'codex', or a basic agent's bare id) as a harness kind: a basic agent is `acp:<id>`. */
export const kindOfAgent = (id: string) => (isHostFamily(id) ? id : `acp:${id}`) as HarnessKind;

export { agentOfKind };

export { hostAgentOf };

/** Which first-tier agent is Claude Code (a table, so a new agent has to answer; a basic agent's id is in neither row). */
const IS_CLAUDE: Record<HarnessId, boolean> = { claude: true, codex: false };
/** Whether the agent a chat on a machine runs on now is Claude Code (its goal and init commands go out as typed). */
export const hostRunsClaude = (chatId: string): boolean => IS_CLAUDE[hostAgentOf(chatId) as HarnessId] === true;

/** The Host's refusal as one line for the picker. @param {unknown} e @param {string} machine */
export function switchRefusal(e: unknown, machine: string): string {
  const x = e as { code?: string; message?: string } | null;
  if (x?.code === 'feature_missing') return `Update ${machine} to switch agents.`;
  return x?.message || `${machine} could not switch this chat.`;
}

/**
 * Pick another agent (and model) for a chat on a machine. Resolves null when the Host holds the choice, else the line to show; nothing changes here until the Host agreed.
 * @param {string} chatId @param {{ agent: string, model?: string, modelLabel: string, effort?: string }} pick (no model: the agent's own default, for a machine that reports none for it) @param {string} machine the machine's name
 */
export async function switchMachineChat(
  chatId: string,
  pick: { agent: string; model?: string; modelLabel: string; effort?: string },
  machine: string,
): Promise<string | null> {
  const harness = kindOfAgent(pick.agent);
  try {
    await native.host.switchChat(chatId, {
      harness,
      ...(pick.model ? { model: pick.model } : {}),
      ...(pick.effort ? { effort: pick.effort } : {}),
    });
  } catch (e) {
    return switchRefusal(e, machine);
  }
  await setSession(chatId, {
    pendingSwitch: { harness, model: pick.model ?? null, modelLabel: pick.modelLabel, effort: pick.effort ?? null, mode: 'auto' },
  });
  return null;
}

/** The person took the choice back (the chip's Undo, or the chat's own agent picked again): the Host drops it too, so the next message stays where it is. @param {string} chatId @param {string} current the agent the chat is on now */
export function dropMachineSwitch(chatId: string, current: string): Promise<void> {
  return Promise.resolve(native.host.switchChat(chatId, { harness: kindOfAgent(current) })).then(
    () => undefined,
    ignoring('take back a switch on a machine'),
  );
}

/** The chip's Undo: a chat on a machine has its Host take the choice back too; a chat on this Mac has nothing to tell. @param {string} chatId */
export function undoMachineSwitch(chatId: string): void {
  if (onMachineNow(chatId)) void dropMachineSwitch(chatId, hostAgentOf(chatId));
}

// ACP sub-agents for the agent page: the transcript a sub-agent call carries (agentItems), streamed live and read back from the chat's turns.
import type { Emit } from '../../harness/acpTranslate';
import { get as getState } from '../../store/core';
import { putAgentItems, type AgentItem, type AgentThreadLoader } from '../../store/agentThreads';

type AgentCarrier = { type?: unknown; id?: unknown; agentItems?: unknown };

/** The translator's emit for a chat, also streaming each sub-agent's own items into its agent page. */
export function acpAgentEmit(chatId: string, emit: Emit): Emit {
  return (method, params) => {
    emit(method, params);
    const it = params.item as AgentCarrier | undefined;
    if (it?.type === 'collabAgentToolCall' && Array.isArray(it.agentItems) && it.agentItems.length)
      putAgentItems(chatId, String(it.id), it.agentItems as AgentItem[]);
  };
}

/** The agent page's loader for ACP: the items the sub-agent's call carries in the chat's turns (none: an empty page). */
export const loadAcpAgentThread = (async (chatId, run) => {
  for (const t of getState().runtime[chatId]?.turns ?? []) {
    const it = (t.items as AgentCarrier[]).find((i) => i.type === 'collabAgentToolCall' && i.id === run.key);
    if (it) return Array.isArray(it.agentItems) ? (it.agentItems as AgentItem[]) : [];
  }
  return [];
}) satisfies AgentThreadLoader;

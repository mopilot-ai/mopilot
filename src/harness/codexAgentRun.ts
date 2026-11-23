// Codex sub-agents' runs as the agent page shows them: a spawned agent's run enriched from its child thread's turns.
import { agentRunOf } from '../lib/agentRun';
import type { AgentRun } from '../../shared/model/window';
import type { AgentItem } from '../../shared/model/window';

/** A turn as far as these rules read it (the store's TurnState, or turnFromServer's). */
export type TurnLike = { id?: string; status?: string; items: unknown[]; startedAt?: number | null; completedAt?: number | null };
/** The child thread's metadata, as far as it is read (the store's Thread). */
type ChildMeta = { agentNickname?: string | null; agentRole?: string | null; model?: string | null } | null | undefined;

/** Item types that are the agent talking, not a tool it used. */
const NOT_TOOLS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'statusNote', 'contextCompaction', 'hookPrompt']);

/** A turn list's items, oldest first, the same objects (so settled rows keep their identity). */
export function flattenTurns(turns: TurnLike[]): AgentItem[] {
  return turns.flatMap((t) => (t.items ?? []) as AgentItem[]);
}

/** What a tool item is doing, for an agent's heartbeat ("Running npm test"). */
export function toolLabel(it: AgentItem): string {
  switch (it.type) {
    case 'commandExecution':
      return `Running ${String(it.command ?? 'a command')}`;
    case 'fileChange':
      return 'Editing files';
    case 'webSearch':
      return 'Searching the web';
    case 'mcpToolCall':
      return `Using ${[it.server, it.tool].filter(Boolean).join('.')}`;
    case 'collabAgentToolCall':
      return 'Running agent';
    default:
      return `Using ${String(it.tool ?? it.type)}`;
  }
}

/**
 * A spawn item's run with what its child thread adds: the nickname or role Codex gave the agent, the tools
 * it used and the one it is using now, its final message and when it ran. `startedAt` is the spawn's own
 * start (the parent turn's itemTimes) when the child hasn't run a turn yet.
 */
export function codexAgentRun(
  item: unknown,
  child: { thread?: ChildMeta; turns?: TurnLike[] | null; startedAt?: number | null; tokens?: number | null } = {},
): AgentRun | null {
  const base = agentRunOf(item);
  if (!base || (item as { agent?: unknown }).agent) return base;
  const it = item as { agentsStates?: Record<string, { message?: string | null } | undefined> };
  const turns = child.turns ?? [];
  const items = flattenTurns(turns);
  const tools = items.filter((i) => !NOT_TOOLS.has(i.type));
  const running = base.status === 'running';
  const live = running ? [...tools].reverse().find((i) => i.status === 'inProgress') : undefined;
  const lastMessage = [...items].reverse().find((i) => i.type === 'agentMessage' && String(i.text ?? '').trim());
  const message = it.agentsStates?.[base.key]?.message;
  const first = turns[0]?.startedAt;
  const last = turns[turns.length - 1]?.completedAt;
  const name = child.thread?.agentNickname || child.thread?.agentRole;
  return {
    ...base,
    description: name || base.description,
    model: base.model ?? child.thread?.model ?? null,
    toolUses: tools.length,
    tokens: child.tokens ?? base.tokens,
    latestTool: live ? toolLabel(live) : null,
    startedAt: first ? first * 1000 : (child.startedAt ?? null),
    completedAt: !running && last ? last * 1000 : null,
    report: running ? null : message?.trim() || (lastMessage ? String(lastMessage.text).trim() : null),
  };
}

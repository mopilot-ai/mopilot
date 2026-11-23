// The harness-neutral view of a sub-agent run that the agent rows, agent page and tasks pane read from a turn item.
import { isCodexAgentSpawn } from '../../shared/codexAgentRelations.mjs';
import { conjugateLead } from './conjugate';
import { prefixUnits } from '../../shared/textPrefix.mjs';
import type { AgentRun, AgentStatus } from '../../shared/model/window';
export type { AgentRun, AgentStatus } from '../../shared/model/window';

type Loose = Record<string, unknown> & { type?: string };

const DESCRIPTION_MAX = 80;

/** The first line of a prompt, short enough to title a row. */
export function promptTitle(prompt: string | null | undefined): string {
  const line = (prompt ?? '').trim().split('\n')[0].trim();
  return line.length > DESCRIPTION_MAX ? prefixUnits(line, DESCRIPTION_MAX - 1) + '…' : line;
}

/** A native item status as an agent status. */
export function agentStatus(native: unknown): AgentStatus {
  switch (native) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'errored':
    case 'notFound':
    case 'declined':
      return 'failed';
    case 'interrupted':
    case 'shutdown':
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return 'running';
  }
}

/** The agent run an item stands for, or null when the item is not an agent launch (a wait, a message, a close). */
export function agentRunOf(item: unknown): AgentRun | null {
  const it = item as Loose | null;
  if (!it || typeof it !== 'object') return null;
  if (it.agent && typeof it.agent === 'object') return it.agent as AgentRun;
  if (it.type === 'collabAgentToolCall') {
    if (!isCodexAgentSpawn(it)) return null;
    const ids = Array.isArray(it.receiverThreadIds) ? (it.receiverThreadIds as unknown[]).map(String) : [];
    const key = ids[0] ?? String(it.id);
    const states = (it.agentsStates ?? {}) as Record<string, { status?: unknown } | undefined>;
    const state = states[key]?.status;
    const prompt = typeof it.prompt === 'string' ? it.prompt : null;
    return {
      key,
      description: promptTitle(prompt) || 'Agent',
      prompt,
      model: typeof it.model === 'string' ? it.model : null,
      background: false,
      status: state !== undefined ? agentStatus(state) : it.status === 'inProgress' ? 'running' : agentStatus(it.status),
      toolUses: 0,
      latestTool: null,
      tokens: null,
      startedAt: null,
      completedAt: null,
      report: null,
      transcript: ids.length ? 'full' : 'summary',
    };
  }
  return null;
}

/** The row's verb: "Running agent" / "Ran agent" / "Failed to run agent" (stopped reads as ran, as in Claude Desktop). */
export function agentVerb(status: AgentStatus): string {
  return status === 'running' ? 'Running agent' : status === 'failed' ? 'Failed to run agent' : 'Ran agent';
}

/** The live header for a running agent: the description with its lead verb conjugated, else "Running agent …". */
export function agentRunningLabel(run: Pick<AgentRun, 'description'>): string {
  return conjugateLead(run.description)?.running ?? `Running agent ${run.description}`;
}

const CLAUDE_MODEL_RE = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i;

/** A model as Claude Desktop names it on an agent: "claude-haiku-5-5" is "Haiku 5.5"; anything else is shown as given. */
export function agentModelName(model: string): string {
  const m = CLAUDE_MODEL_RE.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model;
}

/**
 * A settled agent group's summary, as Claude Desktop words it: "Ran 2 agents (1 failed), ran commands". `others` is
 * the summary of the group's other steps ("Ran commands, edited a file"), or empty.
 */
export function agentGroupSummary(runs: readonly Pick<AgentRun, 'status'>[], others: string): string {
  const failed = runs.filter((r) => r.status === 'failed').length;
  const head = `${runs.length === 1 ? 'ran an agent' : `ran ${runs.length} agents`}${failed ? ` (${failed} failed)` : ''}`;
  const text = others ? `${head}, ${others[0].toLowerCase()}${others.slice(1)}` : head;
  return text[0].toUpperCase() + text.slice(1);
}

// A Codex chat's background tasks: the commands it left running (thread/backgroundTerminals/list) and the sub-agents it spawned, as the tasks pane lists them.
import type { BackgroundTask } from '../../shared/model/session';
import type { TaskEvent } from '../../shared/model/store';
import type { BackgroundTerminal } from './codexTranslate';
import { agentRunOf } from '../lib/agentRun';
import { codexAgentRun } from './codexAgentRun';

/** A turn as far as these rules read it (the store's TurnState). */
type TurnLike = { items: unknown[]; itemTimes?: Record<string, { start: number; end?: number }> };
type ChildOf = (key: string) => Parameters<typeof codexAgentRun>[1];

/** Finished tasks kept for the pane's Finished list, newest first. */
export const FINISHED_MAX = 100;

const SHELL = 'codex-shell:';
const AGENT = 'codex-agent:';
export const shellTaskId = (processId: string) => SHELL + processId;
export const agentTaskId = (key: string) => AGENT + key;
/** The app-server process id a shell task stands for, or null for any other task. */
export const shellProcessId = (task: Pick<BackgroundTask, 'id'>) => (task.id.startsWith(SHELL) ? task.id.slice(SHELL.length) : null);

const base = (id: string, type: string, description: string): BackgroundTask => ({
  id,
  type,
  description,
  status: 'running',
  summary: null,
  toolUseId: null,
  subagentType: null,
  workflowName: null,
  parentTaskId: null,
  ambient: false,
});

/** Whether the harness built this agent's run itself (ACP does; Codex's are read from its collab items). */
const acpRun = (item: unknown) => !!(item as { agent?: unknown }).agent;

/** When an item of the chat started, as the window timed it (ms), or null. */
function itemStart(turns: TurnLike[], itemId: string): number | null {
  for (const t of turns) {
    const at = t.itemTimes?.[itemId]?.start;
    if (at) return at;
  }
  return null;
}

export interface CodexTaskInput {
  turns: TurnLike[];
  /** this poll's background terminals; null when the list couldn't be read (shells then stay as they were) */
  terminals: BackgroundTerminal[] | null;
  /** the tasks last published for the chat */
  prev: BackgroundTask[];
  /** shell tasks the user stopped: they settle as stopped instead of completed */
  stopped: ReadonlySet<string>;
  child: ChildOf;
  now: number;
}

/**
 * The chat's tasks now, and the ones that settled since `prev` (for their transcript events). A shell that
 * leaves the list has ended (the app-server reports no exit status, so it reads as completed); an agent
 * settles with its collab status. Agents first seen already settled (an opened chat's history) are listed
 * as finished without an event.
 */
export function buildCodexTasks(input: CodexTaskInput): { tasks: BackgroundTask[]; settled: BackgroundTask[] } {
  const { turns, terminals, prev, stopped, child, now } = input;
  const before = new Map(prev.map((t) => [t.id, t]));
  const next = new Map<string, BackgroundTask>();
  const settled: BackgroundTask[] = [];
  // Recheck late exit codes once per snapshot, rather than rescanning history for every finished shell.
  let failures: Map<unknown, boolean> | undefined;
  const shellFailed = (task: BackgroundTask) => (failures ??= shellFailures(turns, prev)).get(task.toolUseId) ?? false;

  for (const t of terminals ?? []) {
    const id = shellTaskId(t.processId);
    const p = before.get(id);
    next.set(id, {
      ...base(id, 'local_bash', t.command || 'Background command'),
      toolUseId: t.itemId || null,
      command: t.command,
      startedAt: p?.startedAt ?? itemStart(turns, t.itemId) ?? now,
      completedAt: null,
      output: t.itemId ? { kind: 'process', id: t.itemId } : null,
      stoppable: true,
    });
  }

  for (const t of turns) {
    for (const item of t.items) {
      const bare = agentRunOf(item);
      if (!bare) continue;
      const run = codexAgentRun(item, { ...child(bare.key), startedAt: itemStart(turns, String((item as { id?: unknown }).id)) })!;
      const id = agentTaskId(run.key);
      const p = before.get(id);
      const done = run.status !== 'running';
      const settling = done && p?.status === 'running';
      const task: BackgroundTask = {
        ...base(id, 'local_agent', run.description),
        status: run.status,
        summary: run.latestTool,
        startedAt: p?.startedAt ?? run.startedAt ?? now,
        completedAt: done ? (p?.completedAt ?? run.completedAt ?? (settling ? now : null)) : null,
        latestTool: run.latestTool,
        model: run.model,
        tokens: run.tokens,
        toolUses: run.toolUses,
        agentKey: run.key,
        // stopping one interrupts the turn its child thread runs; an ACP agent has no such request, nor does a settled one
        stoppable: !done && !!run.key && !acpRun(item),
      };
      next.set(id, task);
      if (settling) settled.push(task);
    }
  }

  for (const p of prev) {
    if (next.has(p.id)) continue;
    // a shell gone from a list that was read has ended; anything else not seen now (an unloaded turn) stays as it was
    if (p.status === 'running' && terminals && shellProcessId(p)) {
      const t = {
        ...p,
        status: stopped.has(p.id) ? 'stopped' : shellFailed(p) ? 'failed' : 'completed',
        completedAt: now,
        stoppable: false,
      };
      next.set(p.id, t);
      settled.push(t);
    } else if (p.status === 'completed' && shellProcessId(p) && shellFailed(p)) {
      // the exit code reached the command item after the shell left the list: it did not end well after all
      next.set(p.id, { ...p, status: 'failed' });
    } else next.set(p.id, p);
  }

  const all = [...next.values()];
  const finished = all
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, FINISHED_MAX);
  return { tasks: [...all.filter((t) => t.status === 'running'), ...finished], settled };
}

/** The transcript card for a task that settled. */
export function taskEvent(task: BackgroundTask): TaskEvent {
  return {
    taskId: task.id,
    kind: task.type === 'local_agent' ? 'agent' : 'shell',
    title: task.description,
    status: task.status as TaskEvent['status'],
    durationMs: task.startedAt && task.completedAt ? task.completedAt - task.startedAt : null,
    toolUseId: task.toolUseId,
  };
}

/** The first command match owns a shell's exit code; keep only task IDs and discard the index after this poll. */
function shellFailures(turns: TurnLike[], tasks: BackgroundTask[]): Map<unknown, boolean> {
  const pending = new Set<unknown>(
    tasks
      .filter((task) => shellProcessId(task) && (task.status === 'running' || task.status === 'completed'))
      .map((task) => task.toolUseId),
  );
  // Matching used strict equality: a malformed NaN ID must never match another NaN.
  pending.delete(NaN);
  const failures = new Map<unknown, boolean>();
  if (!pending.size) return failures;
  for (const t of turns) {
    for (const it of t.items as { type?: unknown; id?: unknown; exitCode?: unknown }[]) {
      if (it?.type !== 'commandExecution' || !pending.has(it.id)) continue;
      failures.set(it.id, typeof it.exitCode === 'number' && it.exitCode !== 0);
      pending.delete(it.id);
      if (!pending.size) return failures;
    }
  }
  return failures;
}

/** A shell task's output so far: its command item's aggregated output in the chat's turns (output.id is the item id); null when the command isn't on screen. */
export function codexShellOutput(turns: TurnLike[], itemId: string): string | null {
  for (const t of turns) {
    const it = (t.items as { type?: unknown; id?: unknown; aggregatedOutput?: unknown }[]).find(
      (i) => i?.type === 'commandExecution' && i.id === itemId,
    );
    // the command is on screen: no output yet is an empty output, not an unavailable one
    if (it) return typeof it.aggregatedOutput === 'string' ? it.aggregatedOutput : '';
  }
  return null;
}

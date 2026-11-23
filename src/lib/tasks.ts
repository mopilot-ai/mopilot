// What the Background tasks tab and pill show for a task (any harness): its kind, title, status words, sections, the shared clock and the double Esc.
import { ownTable } from '../../shared/ownTable.mjs';
import { useSyncExternalStore } from 'react';
import type { BackgroundTask } from '../../shared/model/session';
import { compactCount } from './format';

export type CardKind = 'workflow' | 'agent' | 'monitor' | 'shell' | 'task';

/** A task's kind from its harness-neutral type (local_agent, remote_agent, local_bash, local_workflow, monitor_*, …). */
export function cardKind(type: string | null): CardKind {
  if (!type) return 'task';
  if (type === 'local_bash' || type === 'shell') return 'shell';
  if (type.includes('workflow')) return 'workflow';
  if (type.startsWith('monitor')) return 'monitor';
  if (type.includes('agent') || type === 'in_process_teammate') return 'agent';
  return 'task';
}

/** The type word on a card's first meta line. */
export const KIND_LABEL: Record<CardKind, string> = {
  agent: 'Agent',
  shell: 'Bash',
  workflow: 'Workflow',
  monitor: 'Monitor',
  task: 'Task',
};

const RUNNING = new Set(['running', 'pending', 'paused']);

/** Whether a task is still running (anything that has not settled). */
export const isRunningTask = (t: Pick<BackgroundTask, 'status'>): boolean => RUNNING.has(t.status);

/**
 * Whether a sub-agent task waits on the user: one of the chat's pending approvals is a call the agent made. Claude
 * names the agent (`agentID` is the task's id); Codex names the agent's thread (`threadId` is the task's `agentKey`).
 */
export const awaitsApproval = (approvals: { params: unknown }[], task: Pick<BackgroundTask, 'id' | 'agentKey'>): boolean =>
  approvals.some((a) => {
    const p = a.params as { agentID?: unknown; threadId?: unknown } | null;
    return p?.agentID === task.id || (!!task.agentKey && p?.threadId === task.agentKey);
  });

/** The status word a settled card shows; null while it runs. */
export function statusWord(status: string): string | null {
  return status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : status === 'stopped' ? 'Stopped' : null;
}

/**
 * A short name for a shell command, for a task that has no description of its own (Codex sends none): its first
 * line, without a leading `cd dir &&` or a heredoc's body. `python3 - <<'PY'` reads "python3 script".
 */
export function commandTitle(command: string): string {
  const line = command.split('\n').find((l) => l.trim()) ?? '';
  const bare = line.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
  const script = /^(\S+)\s+-\s*<<-?\s*(['"]?)\w+\2\s*$/.exec(bare);
  if (script) return `${script[1]} script`;
  return bare.replace(/\s*<<-?\s*(['"]?)\w+\1/, '') || bare;
}

/** A card's title: the task's description (Claude names a command), else a shell's command shortened, else its summary. */
export function taskTitle(t: BackgroundTask): string {
  const shell = cardKind(t.type) === 'shell';
  if (shell && t.command && (!t.description || t.description.trim() === t.command.trim())) return commandTitle(t.command);
  return t.description || t.summary || t.id;
}

/** How long a task ran (or has run so far, at `now`); null when its start is unknown. */
export function taskElapsed(t: Pick<BackgroundTask, 'startedAt' | 'completedAt'>, now: number): number | null {
  if (!t.startedAt) return null;
  return Math.max(0, (t.completedAt ?? now) - t.startedAt);
}

/** "950 tokens", "165.4k tokens", "1.2M tokens". */
export function formatTokens(n: number): string {
  return `${compactCount(n)} tokens`;
}

const VERBS: Record<string, string> = ownTable({
  bash: 'Running a command',
  shell: 'Running a command',
  command: 'Running a command',
  powershell: 'Running a command',
  read: 'Reading a file',
  edit: 'Editing a file',
  multiedit: 'Editing a file',
  write: 'Writing a file',
  grep: 'Searching files',
  glob: 'Searching files',
  search: 'Searching files',
  ls: 'Exploring files',
  webfetch: 'Fetching a page',
  websearch: 'Searching the web',
  agent: 'Running an agent',
  task: 'Running an agent',
  todowrite: 'Updating the plan',
});

/** An agent's latest tool as a running verb: "Running a command", "Using github". */
export function toolVerb(tool: string): string {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return `Using ${mcp[1]}`;
  return VERBS[tool.toLowerCase()] ?? `Using ${tool}`;
}

/** One task in a section, with the tasks it started nested under it. */
export interface TaskNode {
  task: BackgroundTask;
  children: TaskNode[];
}

const anyRunning = (n: TaskNode): boolean => isRunningTask(n.task) || n.children.some(anyRunning);

/** The tab's "Running" and "Finished" sections: a task under a shown parent nests in it; a card stays in Running while it or anything nested in it runs. */
export function taskSections(tasks: BackgroundTask[]): { running: TaskNode[]; finished: TaskNode[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const node = (t: BackgroundTask): TaskNode => ({
    task: t,
    children: tasks.filter((c) => c.parentTaskId === t.id && c.id !== t.id).map(node),
  });
  const top = tasks.filter((t) => !t.parentTaskId || !ids.has(t.parentTaskId) || t.parentTaskId === t.id).map(node);
  return { running: top.filter(anyRunning), finished: top.filter((n) => !anyRunning(n)) };
}

/** The pill's label. */
export const runningLabel = (n: number) => (n === 1 ? '1 running task' : `${n} running tasks`);
export const finishedLabel = (n: number) => (n === 1 ? '1 task finished' : `${n} tasks finished`);
/** A task that has stopped on an approval only the user can answer is counted apart from the ones still working. */
export const waitingLabel = (n: number) => (n === 1 ? '1 needs you' : `${n} need you`);

/** How long the pill keeps "N tasks finished" after the last running task settles. */
export const FINISHED_HOLD_MS = 1500;

/** Output tailing: how much a card shows and how often a running task's output is read again (slower as it grows). */
export const OUTPUT_TAIL_CHARS = 8000;
export function outputPollMs(length: number): number {
  return length > 512 * 1024 ? 10_000 : length > 128 * 1024 ? 5_000 : 2_000;
}
/** After a failed read: 10 s doubling per failure, at most a minute. */
export const outputRetryMs = (failures: number) => Math.min(60_000, 10_000 * 2 ** Math.max(0, failures - 1));

/* ---------------------------------------------------------------- one shared clock for every live timer */

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockSubs = new Set<() => void>();

function subscribeClock(l: () => void) {
  clockSubs.add(l);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockSubs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    clockSubs.delete(l);
    if (!clockSubs.size) {
      clearInterval(clockTimer!);
      clockTimer = null;
    }
  };
}
const noop = () => undefined;
const idle = () => noop;

/** The time every live task timer reads: one 1 s tick shared by all of them, running only while one is active. */
export function useTaskClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribeClock : idle, () => clockNow);
}

/* ---------------------------------------------------------------- double Esc */

/** A second Esc within this long of the first offers to stop every background task. */
export const ESC_WINDOW_MS = 2000;

/** What an Esc press does: remember it, or (a second one in time, with tasks live) offer Stop all. */
export function escStep(lastEsc: number, now: number, liveTasks: number): { offer: boolean; lastEsc: number } {
  if (liveTasks > 0 && lastEsc > 0 && now - lastEsc < ESC_WINDOW_MS) return { offer: true, lastEsc: 0 };
  return { offer: false, lastEsc: now };
}

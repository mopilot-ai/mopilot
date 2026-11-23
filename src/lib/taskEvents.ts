// Background task events in a turn's transcript: one entry per task (its latest state, at its first place), consecutive ones grouped, none for a task its step row shows.
import type { BackgroundTask } from '../../shared/model/session';
import type { StatusNoteItem, TaskEvent } from '../../shared/model/store';
import { isRunningTask } from './tasks';
import { pluralize } from './format';

/** A task status note carrying the run of task events it stands for. */
export type TaskNote = StatusNoteItem & { task: TaskEvent; events: TaskEvent[] };

const isTaskNote = (i: { type: string }): i is StatusNoteItem & { task: TaskEvent } =>
  i.type === 'statusNote' && (i as StatusNoteItem).kind === 'task' && !!(i as StatusNoteItem).task;

/**
 * Later events for a task update its first entry in place (the last one wins); task events next to each
 * other become one entry whose `events` the card groups.
 */
export function foldTaskEvents<T extends { type: string }>(items: T[]): T[] {
  if (!items.some(isTaskNote)) return items;
  const latest = new Map<string, TaskEvent>();
  for (const i of items) if (isTaskNote(i)) latest.set(i.task.taskId, i.task);
  const out: T[] = [];
  const seen = new Set<string>();
  let run: TaskNote | null = null;
  for (const i of items) {
    if (!isTaskNote(i)) {
      run = null;
      out.push(i);
      continue;
    }
    const id = i.task.taskId;
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = latest.get(id)!;
    if (run) run.events.push(ev);
    else {
      run = { ...i, task: ev, events: [ev] };
      out.push(run as unknown as T);
    }
  }
  return out;
}

/** The events a task note shows: its group, or just its own. */
export const noteEvents = (item: StatusNoteItem & { task: TaskEvent }): TaskEvent[] => (item as Partial<TaskNote>).events ?? [item.task];

const NOUN: Record<TaskEvent['kind'], string> = {
  agent: 'agent',
  shell: 'command',
  workflow: 'workflow',
  monitor: 'monitor',
  task: 'task',
};
const ORDER: TaskEvent['status'][] = ['completed', 'failed', 'stopped', 'running'];

/** "Background command completed" for one settled event. */
export const eventHeadline = (e: TaskEvent) => `Background ${NOUN[e.kind]} ${e.status}`;

/** The parts of a group's summary, "2 background commands completed" then "1 failed", each marked when it counts failures. */
export function groupParts(events: TaskEvent[]): { text: string; danger: boolean }[] {
  const kinds = new Set(events.map((e) => e.kind));
  const noun = kinds.size === 1 ? NOUN[events[0].kind] : 'task';
  const parts = ORDER.map((s) => [s, events.filter((e) => e.status === s).length] as const).filter(([, n]) => n > 0);
  return parts.map(([status, n], i) => ({
    text: i === 0 ? `${pluralize(n, `background ${noun}`)} ${status}` : `${n} ${status}`,
    danger: status === 'failed',
  }));
}

/** "2 background commands completed, 1 failed, 1 running" for a group. */
export const groupSummary = (events: TaskEvent[]): string =>
  groupParts(events)
    .map((p) => p.text)
    .join(', ');

/** Kinds whose starting step's row shows the task's state: a command row (live link, failure) and an Agent row. */
const ROW_SHOWS: ReadonlySet<TaskEvent['kind']> = new Set(['shell', 'agent']);

/**
 * The events a transcript note still has to show: a command or agent started by a step the transcript shows (a Claude
 * tool call, a Codex command item) is that step's row, running or settled, so it gets no note of its own. Notes saved
 * before events carried the step find it on the chat's task list. A monitor or workflow keeps its note: its tool
 * row says nothing of the task.
 */
export function eventsWithoutRow(events: TaskEvent[], tasks: Pick<BackgroundTask, 'id' | 'toolUseId'>[]): TaskEvent[] {
  return events.filter((e) => !(ROW_SHOWS.has(e.kind) && (e.toolUseId ?? tasks.find((t) => t.id === e.taskId)?.toolUseId)));
}

/** A running event whose task has since settled shows how it ended (the settle note can sit in a later turn). */
export function reconcileEvents(events: TaskEvent[], tasks: BackgroundTask[]): TaskEvent[] {
  return events.map((e) => {
    const t = e.status === 'running' ? tasks.find((x) => x.id === e.taskId) : undefined;
    if (!t || isRunningTask(t)) return e;
    const status = t.status === 'failed' ? 'failed' : t.status === 'stopped' || t.status === 'killed' ? 'stopped' : 'completed';
    return { ...e, status, durationMs: t.startedAt && t.completedAt ? t.completedAt - t.startedAt : e.durationMs };
  });
}

// Every background task a chat has, whatever harness runs it: main's session tasks plus tasks a renderer-side adapter reports, and how to stop one.
import { useSyncExternalStore } from 'react';
import type { BackgroundTask, BackgroundWork } from './session/sessionState';
import { isRunningTask } from '../lib/tasks';

/** Stops one task; resolves false when the harness refused. */
/** Resolves true when it stopped, 'retired' when the task had already ended (liveAction says so), false otherwise. */
export type TaskStopper = (chatId: string, task: BackgroundTask) => Promise<boolean | 'retired'>;

/** Reads a task's output so far; null when the harness has none for it. */
export type TaskOutputReader = (task: BackgroundTask) => Promise<string | null>;

const adapterTasks = new Map<string, { source: string; tasks: BackgroundTask[] }>();
let sourceFor = (chatId: string) => chatId;
const stopping = new Map<string, Map<string, { source: string; owned: boolean }>>();
const listeners = new Set<() => void>();
const NONE: BackgroundTask[] = [];
let stopperFor: (chatId: string, source?: BackgroundTask['source']) => TaskStopper | null = () => null;
let readerFor: (chatId: string, source?: BackgroundTask['source']) => TaskOutputReader | null = () => null;
let revision = 0;
const emit = () => {
  revision += 1;
  listeners.forEach((l) => l());
};

/** Structural equality for plain task data (objects, arrays, scalars), without serializing a whole list every poll. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((k) => left[k] !== undefined);
  if (keys.length !== Object.keys(right).filter((k) => right[k] !== undefined).length) return false;
  return keys.every((k) => sameValue(left[k], right[k]));
}

/** Replace the tasks a renderer-side adapter (Codex) reports for a chat; a poll that read the same tasks changes nothing. */
export function putAdapterTasks(chatId: string, tasks: BackgroundTask[]) {
  const prev = adapterTasks.get(chatId);
  const source = sourceFor(chatId);
  if (tasks.length ? prev?.source === source && sameValue(prev.tasks, tasks) : !prev) return;
  if (tasks.length) adapterTasks.set(chatId, { source, tasks });
  else adapterTasks.delete(chatId);
  emit();
}

/** Bind adapter task caches to the selected native source; wired once at boot. */
export function setAdapterTaskSourceResolver(f: (chatId: string) => string) {
  sourceFor = f;
}

/** Choose how a chat's tasks are stopped (the store wires this to the chat's current adapter). */
export function setTaskStopperResolver(f: (chatId: string, source?: BackgroundTask['source']) => TaskStopper | null) {
  stopperFor = f;
}

/** Choose how a chat's task output is read (the store wires this to the chat's current adapter). */
export function setTaskOutputReaderResolver(f: (chatId: string, source?: BackgroundTask['source']) => TaskOutputReader | null) {
  readerFor = f;
}

/** The reader for a chat's task output, or null when its harness can't read one. */
export const taskOutputReader = (chatId: string, source?: BackgroundTask['source']): TaskOutputReader | null => readerFor(chatId, source);

/** Ids of tasks whose stop is in flight, shown as "Stopping…". */
export const stoppingIds = (chatId: string): ReadonlySet<string> => {
  return new Set(
    [...(stopping.get(chatId) ?? [])].filter(([, entry]) => entry.owned || entry.source === sourceFor(chatId)).map(([id]) => id),
  );
};

/** Merge main's session tasks with an adapter's; main's win on the same id. */
export function mergeTasks(session: BackgroundTask[], adapter: BackgroundTask[]): BackgroundTask[] {
  if (!adapter.length) return session;
  const ids = new Set(session.map((t) => t.id));
  return [...session, ...adapter.filter((t) => !ids.has(t.id))];
}

/** The tasks that keep a chat working after its turn: main's and the adapter's still running, without housekeeping. */
export function activeTasks(session: BackgroundTask[], adapter: BackgroundTask[]): BackgroundTask[] {
  return mergeTasks(session, adapter).filter((t) => !t.ambient && isRunningTask(t));
}

/** How much adapter work main counts for a chat (session.backgroundWork), when it is the chat's current task source's. */
export function mainAdapterWork(chatId: string, work: BackgroundWork | null | undefined): number {
  if (!work || JSON.stringify([work.source.kind, work.source.key]) !== sourceFor(chatId)) return 0;
  return work.shells + work.agents;
}

/**
 * How many tasks keep a chat working after its turn: main's own (Claude Code's), plus the adapter's (Codex's) as this
 * window polled them or as main counts them, whichever knows of more. A window that never polled the chat (a new or
 * reloaded one, or one where it was never opened) still knows its work runs; one that did lists each task.
 */
export function runningTaskCount(
  chatId: string,
  session: { tasks: BackgroundTask[]; backgroundWork?: BackgroundWork | null },
  adapter: BackgroundTask[],
): number {
  const listed = activeTasks(session.tasks, adapter).length;
  // main's count and this window's poll are one set of work: only what main counts beyond the poll is added
  return listed + Math.max(0, mainAdapterWork(chatId, session.backgroundWork) - activeTasks([], adapter).length);
}

/** Chats whose current adapter tasks include one still running, for polling them until it settles. */
export function chatsWithAdapterWork(): string[] {
  return [...adapterTasks.keys()].filter((id) => activeTasks([], adapterTasksOf(id)).length > 0);
}

/** Stop a task: it shows "Stopping…" at once and settles when the harness reports it. */
export async function stopBackgroundTask(chatId: string, task: BackgroundTask): Promise<boolean | 'retired'> {
  const stop = stopperFor(chatId, task.source);
  if (!stop || task.stoppable === false) return false;
  const source = task.source ? JSON.stringify([task.source.kind, task.source.key]) : sourceFor(chatId);
  if (stopping.get(chatId)?.get(task.id)?.source === source) return false;
  const entry = { source, owned: !!task.source };
  const active = new Map(stopping.get(chatId));
  active.set(task.id, entry);
  stopping.set(chatId, active);
  emit();
  const ok = await stop(chatId, task).catch((e) => {
    console.warn('Stopping a task failed', e);
    return false;
  });
  if (stopping.get(chatId)?.get(task.id) !== entry) return ok;
  const next = new Map(stopping.get(chatId));
  next.delete(task.id);
  stopping.set(chatId, next);
  emit();
  return ok;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** A chat's adapter-reported tasks for its current source (the UI merges them with the session's through mergeTasks). */
export function adapterTasksOf(chatId: string): BackgroundTask[] {
  const entry = adapterTasks.get(chatId);
  return entry?.source === sourceFor(chatId) ? entry.tasks : NONE;
}

/** A chat's adapter-reported tasks, re-rendering when they change. */
export function useAdapterTasks(chatId: string): BackgroundTask[] {
  return useSyncExternalStore(subscribe, () => adapterTasksOf(chatId));
}

/** Invalidate a list only when its chats' active-task membership changes, not on progress or another chat's work. */
export function useAdapterTaskActivity(chatIds: readonly string[]): void {
  useSyncExternalStore(subscribe, () => JSON.stringify(chatIds.map((id) => activeTasks([], adapterTasksOf(id)).map((task) => task.id))));
}

/** Re-render when any chat's adapter tasks change, for a reader of several chats (adapterTasksOf each). */
export function useAdapterTasksRevision(): number {
  return useSyncExternalStore(subscribe, () => revision);
}

/** Re-render when a stop starts or ends. */
export function useStoppingIds(chatId: string): ReadonlySet<string> {
  useSyncExternalStore(subscribe, () => stopping.get(chatId));
  return stoppingIds(chatId);
}

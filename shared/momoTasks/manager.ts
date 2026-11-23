// MoMo "Gets it done": the task manager the home wires. Session tasks on a chosen machine (runs.ts), model-free watches (watching.ts), and the grouped view the Tasks tab reads.
import { createCore, type ManagerPorts } from './core.ts';
import { createRuns } from './runs.ts';
import { createWatching } from './watching.ts';
import type { Item } from './types.ts';

export { TaskRefusal, type ManagerPorts, type WatchReader, RETRIES, BASE_ATTEMPTS, HARD_ATTEMPTS, MAX_WORKING } from './core.ts';
export type { StartResult } from './runs.ts';

export function createTaskManager(ports: ManagerPorts) {
  const core = createCore(ports);
  const runs = createRuns(core);
  const watching = createWatching(core);
  return {
    ...runs,
    ...watching,
    flushCards: core.flushCards,
    list: () => ports.store.list(),
    get: (id: string) => ports.store.get(id),
  };
}
export type TaskManager = ReturnType<typeof createTaskManager>;

export type TaskGroups = { needsYou: Item[]; working: Item[]; watching: Item[]; doneToday: Item[] };

/** The Tasks tab's groups. A failed task needs the user (Retry, Run on another machine); a stopped one is not shown. `dayStart` is local midnight in ms. */
export function groupTasks(items: Item[], dayStart: number): TaskGroups {
  const byNewest = (a: Item, b: Item): number => b.updatedAt - a.updatedAt;
  const pick = (test: (i: Item) => boolean): Item[] => items.filter(test).sort(byNewest);
  return {
    needsYou: pick((i) => i.state === 'needs_you' || (i.state === 'failed' && i.updatedAt >= dayStart)),
    working: pick((i) => i.state === 'working'),
    watching: pick((i) => i.state === 'watching'),
    doneToday: pick((i) => i.state === 'done' && i.updatedAt >= dayStart),
  };
}

// The scheduled tasks a side panel or a phone lists (scheduled.list): the active ones with a time, soonest first, each with the machine it runs on when it has one (app/hostSchedulesWiring.cjs phoneFields).
const scheduler = require('../platform/scheduler.cjs');

/**
 * @param {{ list: () => Promise<{ tasks: any[] }> }} store the scheduled tasks (platform/automationStore.cjs)
 * @param {(task: any) => object | undefined} [machineFields] the task's machine fields, once the scheduler is wired
 * @param {() => Date} [now]
 * @param {(rule: string, from: Date) => Date | null} [nextRun] when a rule runs next (platform/scheduler.cjs), the caller's own when it has one
 */
async function scheduledList(store, machineFields = () => undefined, now = () => new Date(), nextRun = scheduler.nextRun) {
  const tasks = (await store.list()).tasks
    .filter((t) => t.status === 'ACTIVE' && t.rrule)
    .map((t) => ({
      id: String(t.id),
      name: String(t.name || t.id),
      next: nextRun(t.rrule, now())?.getTime() ?? null,
      ...machineFields(t),
    }));
  // soonest first; one with no next time after them
  const timed = tasks.filter((t) => t.next !== null).sort((a, b) => Number(a.next) - Number(b.next));
  return [...timed, ...tasks.filter((t) => t.next === null)];
}

module.exports = { scheduledList };

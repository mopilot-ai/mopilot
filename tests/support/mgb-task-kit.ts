// Shared setup for the MGB task tests (#1381): the bench modules they drive and a task's seeded starting state.
export const { auditEnv, auditTask } = await import('../../bench/lib/mgb/audit.mjs');
export const { loadFixtures } = await import('../../bench/lib/mgb/apps/index.mjs');
export const { gradeTask } = await import('../../bench/lib/mgb/grade.mjs');
export const { taskRng } = await import('../../bench/lib/mgb/seed.mjs');
export const { browse } = await import('../../bench/lib/mgb/tasks/drive.mjs');

/** A task's data and loaded app state for one seed, with `env` laid over the audit's environment. */
export const setupTask = <E extends object = {}>(task: any, seed = 's1', env = {} as E) => {
  const e = { ...auditEnv(seed, task), ...env };
  const data = task.data(taskRng(seed, task.id), e);
  return { env: e, data, state: loadFixtures(task.fixtures(data, e)) };
};

/** The ids of a grade's checkpoints that were not met. */
export const unmet = (g: any): string[] => g.checkpoints.filter((c: any) => !c.met).map((c: any) => c.id);

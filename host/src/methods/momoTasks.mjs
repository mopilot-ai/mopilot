// The Host's handler for `host.momoTasks` (shared/host/methods/momoTasks.mjs): thin calls into the tasks service, read with `momo.service('tasks')` inside each call (never at load). Like every MoMo method it is veiled, and what a task does is the owner's: only a paired desktop or phone may start, stop or retry one, never the local command line, which any process on this machine can reach.
import { HostRefusal } from '../hostFs.mjs';
import { isOwner } from '../momoOwner.mjs';
import { TaskRefusal } from '../../../shared/momoTasks/core.ts';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  const home = /** @type {NonNullable<typeof momo>} */ (momo);
  const tasks = () => /** @type {any} */ (home.service('tasks'));
  /** A refusal of the tasks is told with its own words and code. @template T @param {() => Promise<T>} run @returns {Promise<T>} */
  const told = async (run) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TaskRefusal) throw new HostRefusal(error.code, error.message);
      throw error;
    }
  };
  return {
    veils: { 'host.momoTasks': (/** @type {unknown} */ principal) => !!momo && !!principal && isOwner(principal) && !!momo.granted() },
    handlers: {
      'host.momoTasks': (/** @type {any} */ p) =>
        told(async () => {
          switch (p.op) {
            case 'view':
              return { tasks: await tasks().view() };
            case 'create':
              return tasks().create({ title: p.title, doneMeans: p.doneMeans, where: p.where, origin: 'asked', userStarted: true });
            case 'createWatch':
              return {
                item: await tasks().createWatch({
                  title: p.title,
                  doneMeans: p.doneMeans,
                  origin: 'asked',
                  userStarted: true,
                  watch: p.watch,
                }),
              };
            default:
              return tasks().resume(p.id);
          }
        }),
    },
  };
};

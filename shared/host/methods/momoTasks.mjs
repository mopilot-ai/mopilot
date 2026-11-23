// The wire method of MoMo's tasks on a Host (#5474 "Gets it done"): read the tasks, start one, watch something, or resume a watch. What a button does (stop, retry, a card's fix, snooze, check now) is an intent of the tasks lane (shared/momoIntents.mjs), run through `host.momoLaneIntent`. One method with an op, like the notes and the rules. It needs the `momo` feature, so an older Host or an ungranted client sees an unknown request.
import { MOMO_FEATURE } from './momo.mjs';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const OPS = ['view', 'create', 'createWatch', 'resume'];
const MAX_TITLE = 200;
const MAX_DONE_MEANS = 1000;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  /** @param {unknown} v @param {string} what @param {number} max */
  const text = (v, what, max) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`That is not ${what}.`);
    return v;
  };
  /** @param {unknown} v @param {string} what */
  const id = (v, what) => matchOf(v, ID, `That is not ${what}.`);
  /** What a new task is: the client names the title and what done means (and may name where); the Host decides the rest. @param {any} p */
  const made = (p) => {
    const out = { title: text(p.title, 'a title', MAX_TITLE), doneMeans: text(p.doneMeans, 'what done means', MAX_DONE_MEANS) };
    if (p.where === undefined || p.where === null) return out;
    return { ...out, where: { machineId: id(p.where?.machineId, 'a machine id'), harness: id(p.where?.harness, 'an agent') } };
  };
  return {
    features: [MOMO_FEATURE],
    methods: {
      'host.momoTasks': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const op = OPS.find((o) => o === p?.op);
          if (!op) throw bad('That is not something to do with a task.');
          if (op === 'view') return { op };
          if (op === 'create') return { op, ...made(p) };
          if (op === 'createWatch') {
            if (!p.watch || typeof p.watch !== 'object' || Array.isArray(p.watch)) throw bad('That is not something to watch.');
            return { op, ...made(p), watch: p.watch };
          }
          const taskId = id(p.id, 'a task id');
          return { op, id: taskId };
        },
      },
    },
  };
};

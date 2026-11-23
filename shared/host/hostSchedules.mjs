// Scheduled tasks a Host keeps and fires itself (#2709 phase 2): the feature both ends declare, the task as it goes on the wire, and the parsers of `host.scheduleSync` (the app's whole set of tasks for that machine) and `host.scheduleRuns` (the runs the Host fired since a cursor).
import { SchemaError } from '../remote/schema.mjs';
import { isTimeZone } from '../schedule.mjs';

/** The feature a Host that keeps schedules declares; an end without it is never sent one (the app fires the task itself then). */
export const SCHEDULES_FEATURE = 'schedules';
/** The most tasks one app keeps on one machine. */
export const MAX_TASKS = 200;
/** The most runs one `host.scheduleRuns` answer carries; the app asks again from `next`. */
export const MAX_RUNS = 200;

const bad = (/** @type {string} */ m) => new SchemaError(m);
const str = (/** @type {unknown} */ v, /** @type {number} */ max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** An agent a Host runs: Claude Code, Codex or a basic agent's id. */
const AGENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @typedef {{ id: string, name: string, rrule: string, zone: string, prompt: string, harness: string, cwd: string, status: 'ACTIVE' | 'PAUSED',
 *   scheduleFrom: number, model?: string, effort?: string, projectId?: string, onApproval?: 'wait' | 'skip' }} WireTask
 */

/** One task as the Host keeps it, or a SchemaError saying what is wrong. @param {any} t @returns {WireTask} */
export function wireTaskOf(t) {
  if (!t || typeof t !== 'object') throw bad('A scheduled task is needed.');
  if (!str(t.id, 200) || /[\\/]/.test(t.id)) throw bad("That isn't a task id.");
  if (!str(t.rrule, 1000)) throw bad('A scheduled task needs its schedule.');
  if (!isTimeZone(t.zone)) throw bad("That isn't a time zone.");
  if (typeof t.prompt !== 'string' || t.prompt.length > 100_000) throw bad('That prompt is too long.');
  if (typeof t.harness !== 'string' || !AGENT.test(t.harness)) throw bad("That isn't an agent.");
  if (!str(t.cwd, 4096)) throw bad('A scheduled task needs a folder on the machine.');
  if (t.status !== 'ACTIVE' && t.status !== 'PAUSED') throw bad("That isn't a task status.");
  if (!Number.isSafeInteger(t.scheduleFrom) || t.scheduleFrom < 0) throw bad("That isn't a time.");
  if (t.onApproval !== undefined && t.onApproval !== 'wait' && t.onApproval !== 'skip') throw bad("That isn't a way to treat an approval.");
  for (const k of ['model', 'effort', 'projectId']) if (t[k] !== undefined && !str(t[k], 200)) throw bad(`That isn't a ${k}.`);
  return {
    id: t.id,
    name: typeof t.name === 'string' ? t.name.slice(0, 200) : '',
    rrule: t.rrule,
    zone: t.zone,
    prompt: t.prompt,
    harness: t.harness,
    cwd: t.cwd,
    status: t.status,
    scheduleFrom: t.scheduleFrom,
    ...(t.model === undefined ? {} : { model: t.model }),
    ...(t.effort === undefined ? {} : { effort: t.effort }),
    ...(t.projectId === undefined ? {} : { projectId: t.projectId }),
    // absent (an older app) is `wait`: the normal approval clock
    ...(t.onApproval === undefined ? {} : { onApproval: t.onApproval }),
  };
}

/** The parsers of the schedule methods (shared/host/schema.mjs PARSERS). */
export const scheduleParsers = {
  /** The app's whole set of tasks for this machine: what is not in it is no longer kept there. */
  'host.scheduleSync': (/** @type {any} */ p) => {
    if (!Array.isArray(p.tasks) || p.tasks.length > MAX_TASKS) throw bad(`Send at most ${MAX_TASKS} scheduled tasks.`);
    const tasks = p.tasks.map(wireTaskOf);
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw bad('Each scheduled task is sent once.');
    return { tasks };
  },
  /** The runs after the cursor `after` (0: from the start of what the Host keeps). */
  'host.scheduleRuns': (/** @type {any} */ p) => {
    if (!Number.isSafeInteger(p.after) || p.after < 0) throw bad("That isn't a run cursor.");
    return { after: p.after };
  },
};

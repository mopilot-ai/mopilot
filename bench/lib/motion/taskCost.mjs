// Motion bench task cost (#3810): steps, tokens, wall time and pass rate of the 12-Grid Bench runs of the tasks the cursor work is judged on (f4-week-plan, f2-onboarding), read from the runs' records.
import { cellStats } from '../mgb/scorecard.mjs';
import { median, round } from './stats.mjs';

/** The tasks whose runs carry the cost and pass-rate columns. */
export const COST_TASKS = ['f4-week-plan', 'f2-onboarding'];

const numbers = (/** @type {any[]} */ runs, /** @type {string} */ key) =>
  runs.map((r) => r.efficiency?.[key]).filter((v) => typeof v === 'number');

/**
 * Pass rate, steps, tokens and wall time of the runs of the given tasks: medians over gradable runs, the pass rate over
 * all gradable runs (UNGRADABLE and N/A are never failures). Null where no run reports the number.
 * @param {any[]} records mgbRecord objects (a bench run's `<task>.json` files) @param {string[]} [ids]
 */
export function taskCost(records, ids = COST_TASKS) {
  const pick = (/** @type {string[]} */ which) => records.filter((r) => which.includes(r.task));
  const summary = (/** @type {any[]} */ runs) => {
    const cell = cellStats(runs);
    const gradable = runs.filter((r) => r.verdict !== 'UNGRADABLE' && r.verdict !== 'N/A');
    return {
      runs: runs.length,
      gradable: cell.gradable,
      pass: cell.pass,
      passRate: cell.rate,
      steps: round(median(numbers(gradable, 'steps'))),
      tokens: round(median(numbers(gradable, 'tokens')), 0),
      wallMs: round(median(numbers(gradable, 'wallMs')), 0),
    };
  };
  return { ...summary(pick(ids)), byTask: Object.fromEntries(ids.map((id) => [id, summary(pick([id]))])) };
}

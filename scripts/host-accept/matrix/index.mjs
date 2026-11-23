// `--matrix`: the Host side of the Remote Run acceptance matrix (design/remote-run/plan.md, "Acceptance bar"): after the install and pairing, the journey on each harness this machine can run, the multi-agent block and the timings.
import { STEPS } from '../steps.mjs';
import { KEYS } from './common.mjs';
import { journeySteps } from './journey.mjs';
import { MULTI_STEP } from './multi.mjs';
import { TIMINGS_STEP } from './timings.mjs';

/** The base run every matrix needs: the machine, the Host installed, a client paired, the fake agent installed. */
const SETUP = ['A1', 'A2', 'A3', 'A5', 'A6'];

const CELLS = [...KEYS.flatMap((key) => journeySteps(key)), MULTI_STEP, TIMINGS_STEP];
/** The names a cell goes by (`codex/J5`, `multi/six`, `timings`), for `--cell`. */
export const MATRIX_CELLS = CELLS.map((s) => s.id);

/** The steps of a matrix run in order: the setup (each required), each harness's journey, the multi-agent block, the timings; with `cells`, only those. @param {string[]} [cells] */
export const matrixSteps = (cells = []) => [
  ...STEPS.filter((s) => SETUP.includes(s.id)).map((s) => ({ ...s, fatal: true })),
  ...CELLS.filter((s) => !cells.length || cells.includes(s.id)),
];

/** The end of a matrix run: its scratch repos and the files its prompts wrote beside them go, and the timings table (if the run got that far) follows the report. Nothing for a run that is not a matrix. @param {any} ctx @returns {Promise<string>} */
export async function finishMatrix(ctx) {
  for (const fn of ctx.state.cleanups ?? []) await fn();
  return ctx.state.timingsTable ? `\n${ctx.state.timingsTable}` : '';
}

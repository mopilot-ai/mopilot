// DEV ONLY: runs the iOS journey's steps in order against a WebDriverAgent session and the dev host: a screenshot after every step, and a non-zero exit that names the step that failed.
import path from 'node:path';
import { steps as allSteps } from './steps.mjs';

/**
 * @param {{ wda: import('./wda.mjs').Wda, host: import('./host.mjs').JourneyHost, relaunch: () => Promise<void>, out: string, say?: (line: string) => void,
 *   only?: string[], steps?: typeof allSteps, now?: () => number }} o
 * @returns {Promise<{ ok: boolean, failed: string | null, ran: string[] }>}
 */
export async function runJourney({ wda, host, relaunch, out, say = console.log, only = [], steps = allSteps, now = Date.now }) {
  const chosen = only.length ? steps.filter((s) => only.includes(s.name)) : steps;
  const unknown = only.filter((name) => !steps.some((s) => s.name === name));
  if (unknown.length) throw new Error(`no such step: ${unknown.join(', ')}; the steps are ${steps.map((s) => s.name).join(', ')}`);
  /** @type {string[]} */
  const ran = [];
  for (const [index, step] of chosen.entries()) {
    const file = (suffix = '') => path.join(out, `${String(index + 1).padStart(2, '0')}-${step.name}${suffix}.png`);
    const started = now();
    try {
      await step.run({ wda, host, relaunch });
      ran.push(step.name);
      await wda.shot(file()).catch((e) => say(`(no screenshot: ${e.message})`));
      say(`PASS ${step.name} (${((now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      await wda.shot(file('-FAILED')).catch((e) => say(`(no screenshot: ${e.message})`));
      say(`FAIL ${step.name}: ${/** @type {Error} */ (error).message}`);
      say(`journey failed at step "${step.name}"; screenshots are in ${out}`);
      return { ok: false, failed: step.name, ran };
    }
  }
  say(`journey passed: ${ran.length} steps; screenshots are in ${out}`);
  return { ok: true, failed: null, ran };
}

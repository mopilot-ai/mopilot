// Exits 1 when a computer-use helper bundle is not built from this checkout's helper sources (an install step runs it before it leaves a bundle in place, #4320).
//   node scripts/check-helper-bundle.mjs [<MoPilot.app>]   (default native/helper/build/MoPilot.app)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_NAME, bundleProblem } from './build-helper.mjs';

/** @param {string[]} argv @param {{ log?: (m: string) => void, problem?: typeof bundleProblem }} [o] @returns {number} the exit code */
export function check(argv, { log = console.log, problem = bundleProblem } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = path.resolve(argv[0] ?? path.join(root, 'native/helper/build', `${HELPER_NAME}.app`));
  const why = problem(app);
  log(why ? `outdated helper: ${why}` : `helper matches this tree: ${app}`);
  return why ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(check(process.argv.slice(2)));

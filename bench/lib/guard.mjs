// Keeps benchmark runs inside the isolated benchmark VM: they launch and drive real apps, so they never start on a
// real Mac (AGENTS.md release-only policy); the hypervisor flag decides, as for the other release-only suites.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { insideVirtualMachine } = require('../../scripts/release-suites.cjs');

/**
 * Throws, saying why, unless this is a virtual machine.
 * @param {string} what what is starting, e.g. "bench/run.mjs"
 * @param {() => boolean} [inVm]
 */
export function requireVm(what, inVm = insideVirtualMachine) {
  if (inVm()) return;
  throw new Error(
    `${what} runs only inside the benchmark virtual machine: it launches and drives real apps, so AGENTS.md keeps it ` +
      'off real computers. Start it there with scripts/vm-exec.sh (see bench/README.md).',
  );
}

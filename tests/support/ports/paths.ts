// The shared fake of the main process's paths port (electron/platform/ports/paths.cjs, docs/architecture/modularization.md §3):
// a test names the folders it wants; the port is put back after the test.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installPaths } = require('../../../electron/platform/ports/paths.cjs');

/** Install `userData` behind the paths port for the test, and put the previous one back after it. */
export function useFakePaths(t: { after: (fn: () => void) => void }, userData: string) {
  const previous = installPaths({ userData: () => userData });
  t.after(() => installPaths(previous));
}

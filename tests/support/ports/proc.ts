// The shared fake of the main process's proc port (electron/platform/ports/proc.cjs, docs/architecture/modularization.md
// §3): a test names only the calls it replaces; everything else is the real node:child_process.
import { createRequire } from 'node:module';
import { over, type Overrides } from './fs.ts';

const require = createRequire(import.meta.url);
// the CommonJS module the port holds (not the ESM namespace, which is another object)
const childProcess = require('node:child_process');
const { installProc } = require('../../../electron/platform/ports/proc.cjs');

/** Install `overrides` over node:child_process behind the proc port for the test, and put the real one back after it. */
export function useFakeProc(t: { after: (fn: () => void) => void }, overrides: Overrides) {
  const previous = installProc(over(childProcess, overrides));
  t.after(() => installProc(previous));
}

/** Install `fake` as the whole proc port until `restore()`, which puts back what was there (a harness's lifetime). */
export function procPortMock(fake: object) {
  const previous = installProc(fake);
  return { restore: () => installProc(previous) };
}

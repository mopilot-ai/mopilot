// The shared fake of the main process's fs port (electron/platform/ports/fs.cjs, docs/architecture/modularization.md §3):
// a test names only the calls it replaces; everything else is the real node:fs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// the CommonJS module the port holds (not the ESM namespace, which is another object)
const nodeFs = require('node:fs');
const { installFs } = require('../../../electron/platform/ports/fs.cjs');

export type Overrides = Record<string, unknown>;

/** A module with `overrides` in place of the real one's members (`promises` overrides merge with the real promises). */
export function over<T extends object>(real: T, overrides: Overrides): T {
  return new Proxy(real, {
    get: (target, key) => {
      if (key === 'promises' && overrides.promises) return over((target as any).promises, overrides.promises as Overrides);
      return key in overrides ? overrides[key as string] : Reflect.get(target, key);
    },
  });
}

/** Install `overrides` over node:fs behind the fs port for the test, and put the real one back after it. */
export function useFakeFs(t: { after: (fn: () => void) => void }, overrides: Overrides) {
  const previous = installFs(over(nodeFs, overrides));
  t.after(() => installFs(previous));
}

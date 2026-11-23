// The shared fake of the main process's secrets port (electron/platform/ports/secrets.cjs, docs/architecture/modularization.md §3):
// a test names the safeStorage it wants (null for a process without one); the port is put back after the test.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installSecrets } = require('../../../electron/platform/ports/secrets.cjs');

type Safe = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string };

/** Install `safe` behind the secrets port for the test, and put the previous one back after it. */
export function useFakeSecrets(t: { after: (fn: () => void) => void }, safe: Safe | null) {
  const previous = installSecrets(() => safe);
  t.after(() => installSecrets(previous));
}

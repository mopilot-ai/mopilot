// A run on macOS has the Rust core, as tests/e2e/core-loaded-linux.spec.ts shows on Linux: the fake-based specs and the benchmarks exercise it rather than the JS fallbacks, and a run's samples say so.
import { test } from './fixtures/app';
import { expectCoreLoaded, launchSamples } from './fixtures/coreLoaded';
import fs from 'node:fs';
import path from 'node:path';

test.skip(process.platform !== 'darwin', 'tests/e2e/core-loaded-linux.spec.ts covers Linux');
test.use({
  harnesses: 'claude',
  env: { MOPILOT_FLAGS: 'shared.perf.probe=1' },
  seed: {
    files: ({ userData }) => {
      // A busy startup may publish this independent log before the probe's first flush (#3853).
      const dir = path.join(userData, 'perf');
      fs.mkdirSync(dir, { recursive: true });
      for (const file of ['stalls.jsonl', 'stalls.1.jsonl']) {
        fs.writeFileSync(path.join(dir, file), `${JSON.stringify({ kind: 'stall', ms: 701 })}\n`);
      }
    },
  },
});

test('every probe sample of a launch says the core loaded', async ({ harness }) => {
  expectCoreLoaded(await launchSamples(harness.env.MOPILOT_USER_DATA));
});

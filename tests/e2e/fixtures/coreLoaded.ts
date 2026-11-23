// What a run's probe samples say about the Rust core: the same on every line, and printed so the run's log shows which implementation its numbers came from.
import path from 'node:path';
import { expect } from '@playwright/test';
import { readJsonLineLog } from '../../../scripts/fixture-json-log.mjs';
import { probeFiles } from '../../../scripts/perf-probe-files.mjs';

export { probeFiles };

export function expectCoreLoaded(samples: { coreLoaded?: boolean }[]) {
  const seen = [...new Set(samples.map((s) => s.coreLoaded))];
  console.log(`coreLoaded on ${samples.length} samples: ${seen.join(', ')}`);
  expect(samples.length).toBeGreaterThan(0);
  expect(seen).toHaveLength(1);
  expect(typeof seen[0]).toBe('boolean');
  // a run on GitHub's runners has the core (tests/e2e/global-setup.ts); a self-hosted runner may have no Rust toolchain
  if (process.env.RUNNER_ENVIRONMENT === 'github-hosted') expect(seen[0]).toBe(true);
}

/** Every published probe sample of a launch, once main has written any (it does once a second). */
export async function launchSamples(userData: string): Promise<{ coreLoaded?: boolean }[]> {
  const samples = () => probeFiles(userData).flatMap((f) => readJsonLineLog(path.join(userData, 'perf', f)));
  await expect.poll(() => samples().length, { timeout: 15_000 }).toBeGreaterThan(0);
  return samples();
}

// A run on Linux has the Rust core, as tests/e2e/core-loaded.spec.ts shows on macOS. It is the proof the PR check can give: the macOS spec runs after merge, and a core that fails to load falls back to JS with every other spec still passing.
import { test } from './fixtures/app';
import { expectCoreLoaded, launchSamples } from './fixtures/coreLoaded';

test.use({ harnesses: 'claude', env: { MOPILOT_FLAGS: 'shared.perf.probe=1' } });

test('every probe sample of a launch on Linux says the core loaded', async ({ harness }) => {
  expectCoreLoaded(await launchSamples(harness.env.MOPILOT_USER_DATA));
});

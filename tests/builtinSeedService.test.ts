// How main seeds MoPilot's own plugin (electron/plugins/service.cjs builtinReady): once per run, before any
// harness reads the store, a failure never stops a session or a sync. The store is the shared one, with seeding stubbed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builtinReady, pluginService, pluginDelivery } = require('../electron/plugins/service.cjs');

test('seeding runs once per run: a failure is swallowed and not repeated, and the delivery waits for it', async () => {
  const seed = mock.method(pluginService().store, 'seedBundled', async () => {
    throw new Error('disk full');
  });
  const first = builtinReady();
  assert.equal(await first, undefined);
  assert.equal(builtinReady(), first, 'the same run, not a second seed');
  assert.equal(await pluginDelivery().ready(), undefined);
  assert.equal(seed.mock.callCount(), 1);
  seed.mock.restore();
});

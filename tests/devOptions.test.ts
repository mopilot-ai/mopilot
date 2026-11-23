import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devServerOptions } from '../scripts/dev-options.mjs';

test('working dev sessions do not hot update or reload when their source changes', () => {
  assert.deepEqual(devServerOptions({}), { port: 5199, strictPort: true, hmr: false });
  for (const value of ['', '0', 'false', 'true']) {
    assert.equal(devServerOptions({ MOPILOT_DEV_HMR: value }).hmr, false);
  }
});

test('developers can explicitly enable live updates', () => {
  assert.equal(devServerOptions({ MOPILOT_DEV_HMR: '1' }).hmr, true);
});

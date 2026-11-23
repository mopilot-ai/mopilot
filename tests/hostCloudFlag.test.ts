// cloudOn (src/lib/hostCloud.ts): the host.cloud flag as the window reads it; a window with no native bridge shows none of the cloud UI instead of throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

test('no native bridge: cloud machines are off', async () => {
  const { cloudOn } = await import('../src/lib/hostCloud.ts');
  assert.equal(cloudOn(), false);
});

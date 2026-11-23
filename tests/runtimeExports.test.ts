// The types-only check counts runtime values under both module formats, so it cannot pass vacuously.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeExports } from './support/runtimeExports.ts';

test('runtime values are found as ES named exports and as a CommonJS default object; types-only has none', async () => {
  // ES: shared/ is "type": "module"
  assert.ok((await runtimeExports(import('../shared/claudeModels.mjs'))).includes('claudeModels'));
  // a CommonJS-shaped namespace: its values sit on `default`
  assert.deepEqual(await runtimeExports(Promise.resolve({ default: { a: 1 }, 'module.exports': { a: 1 }, a: 1 })), ['a', 'a']);
  assert.deepEqual(await runtimeExports(Promise.resolve({ default: {} })), []);
  assert.deepEqual(await runtimeExports(Promise.resolve({ default: 'text' })), []);
});

test('the shared peer message contract is types only and carries no runtime values', async () => {
  // shared/ is ES (shared/package.json): a types-only module has no exports at all, so no CommonJS `default` either
  assert.deepEqual(await runtimeExports(import('../shared/peerMessages.ts')), []);
});

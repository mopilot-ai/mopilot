// Diagnostics IPC fixtures must stay selected when the production registration or its child wiring changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relatedTests, reverseGraph } from '../scripts/related-tests.mjs';

test('app IPC and its Quick Actions wiring both select the diagnostics registration fixture', () => {
  const users = reverseGraph();
  assert.ok(relatedTests(['electron/app/ipc/app.cjs'], users).includes('tests/capabilityPresentation.test.ts'));
  assert.ok(relatedTests(['electron/platform/quickActionsWiring.cjs'], users).includes('tests/capabilityPresentation.test.ts'));
});

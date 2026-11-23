// The Codex turn reader main reads history with (shared/codexTurns.mjs) loads from CommonJS, which is how main requires it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('main requires the Codex turn reader', () => {
  const { turnFromServer: fromMain } = require('../shared/codexTurns.mjs');
  const t = {
    id: 't1',
    status: 'completed',
    items: [{ type: 'agentMessage', id: 'i', text: 'hi' }],
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    error: null,
  };
  assert.equal(fromMain(t).id, 't1');
  assert.deepEqual(fromMain(t).items, t.items);
  assert.deepEqual(fromMain({ id: 't2', status: 'inProgress' }).items, []);
  assert.equal(fromMain({ ...t, diff: 'full two-file diff' }).diff, 'full two-file diff');
  assert.equal(fromMain({ ...t, diff: '' }).diff, '');
  assert.equal(fromMain(t).diff, undefined);
});

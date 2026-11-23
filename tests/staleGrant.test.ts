// The advice for a macOS privacy switch that is on yet still refused (shared/staleGrant.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleGrantHint } from '../shared/staleGrant.mjs';

test('staleGrantHint: remove and re-add the app in the named list, then reopen it unless told what comes next', () => {
  assert.equal(
    staleGrantHint('MoPilot', 'Full Disk Access'),
    'Already on? It may still belong to an older copy of MoPilot: in Full Disk Access, select MoPilot, remove it with −, add it again with +, then quit and reopen MoPilot.',
  );
  assert.match(
    staleGrantHint('Codex Computer Use', 'both lists', 'choose Check again'),
    /add it again with \+, then choose Check again\.$/,
  );
});

// electron/session/orchestration/userRemoval.cjs: the user removing a queued message tells the linked sessions, when there are any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { removeQueuedForUser } = require('../electron/session/orchestration/userRemoval.cjs');

test('a removed item is reported to the orchestrator, and a missing one is not', () => {
  const seen: unknown[][] = [];
  const item = { id: 'q', sideSession: { id: 's' } };
  const live = {
    controller: { removeQueued: (chat: string, qid: string) => (qid === 'q' ? item : null) },
    orchestrator: { queuedRemoved: (...args: unknown[]) => seen.push(args) },
  };
  assert.equal(removeQueuedForUser(live, 'chat', 'q'), true);
  assert.deepEqual(seen, [['chat', item]]);
  assert.equal(removeQueuedForUser(live, 'chat', 'gone'), false);
  assert.equal(seen.length, 1);
});

test('an app with no linked sessions still removes the item', () => {
  const live = { controller: { removeQueued: () => ({ id: 'q' }) } };
  assert.equal(removeQueuedForUser(live, 'chat', 'q'), true);
});

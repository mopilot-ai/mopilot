// Requests Sage builds for the Codex app-server (see src/lib/codexRequests.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertRequest, reviewRequest } from '../src/lib/codexRequests.ts';

test('edit and resend reverts to before the edited turn', () => {
  assert.deepEqual(revertRequest('thr_1', 'turn_2'), { method: 'thread/revert', params: { threadId: 'thr_1', beforeTurnId: 'turn_2' } });
});

test('reviews are always delivered inline', () => {
  assert.deepEqual(reviewRequest('thr_1', { type: 'uncommittedChanges' }), {
    method: 'review/start',
    params: { threadId: 'thr_1', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
  });
  assert.equal(reviewRequest('thr_1', { type: 'baseBranch', branch: 'main' }).params.delivery, 'inline');
});

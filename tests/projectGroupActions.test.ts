// Combined project deletion preserves serial persistence and exposes a failure without deleting later aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlledReads } from './support/async-scenarios.ts';
import { stubStore } from './support/stubs.ts';

const calls: string[] = [];
let remove = async (_id: string) => {};
stubStore({ deleteProject: (id: string) => (calls.push(id), remove(id)) });
const { deleteProjectGroup } = await import('../src/session/projectGroupActions.ts');

test('single project removal remains supported', async () => {
  calls.length = 0;
  await deleteProjectGroup('one');
  assert.deepEqual(calls, ['one']);
});

test('aliases are deduplicated and removed serially so each state refresh precedes the next write', async () => {
  calls.length = 0;
  const reads = controlledReads<void>();
  remove = () => reads.read();
  const pending = deleteProjectGroup('one', ['one', 'two', 'three']);
  assert.deepEqual(calls, ['one']);
  reads.requests[0].resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['one', 'two']);
  reads.requests[1].resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['one', 'two', 'three']);
  reads.requests[2].resolve();
  await pending;
});

test('a failed alias removal remains retryable and does not start later writes', async () => {
  calls.length = 0;
  remove = async (id) => {
    if (id === 'two') throw new Error('save failed');
  };
  await assert.rejects(deleteProjectGroup('one', ['two', 'three']), /save failed/);
  assert.deepEqual(calls, ['one', 'two']);
  calls.length = 0;
  remove = async () => {};
  await deleteProjectGroup('two', ['three']);
  assert.deepEqual(calls, ['two', 'three']);
});

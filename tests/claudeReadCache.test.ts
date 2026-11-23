// The reads of Claude chats kept across calls (electron/platform/claudeTranscriptRead.cjs createReadCache): what the core holds for
// a transcript that has not changed, and each let go of as it leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createReadCache } = createRequire(import.meta.url)('../electron/platform/claudeTranscriptRead.cjs');

test('the kept reads are bounded by count and by size, the newest is never dropped, and each that leaves is let go of', () => {
  const released: number[] = [];
  const cache = createReadCache(2, 100, (id: number) => released.push(id));
  cache.set('a', 'k', 10, 1);
  cache.set('b', 'k', 10, 2);
  assert.equal(cache.get('a', 'k'), 1);
  assert.equal(cache.get('a', 'other'), null);
  assert.equal(cache.get('none', 'k'), null);
  // c pushes out b (a was used last)
  cache.set('c', 'k', 10, 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b', 'k'), null);
  assert.deepEqual(released, [2]);
  // one transcript past the byte limit stays alone
  cache.set('big', 'k', 500, 4);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('big', 'k'), 4);
  assert.deepEqual(released.sort(), [1, 2, 3]);
  // stored again, its old weight and its old read go
  cache.set('big', 'k2', 20, 5);
  assert.deepEqual(released.at(-1), 4);
  cache.set('d', 'k', 20, 6);
  assert.equal(cache.size, 2);
});

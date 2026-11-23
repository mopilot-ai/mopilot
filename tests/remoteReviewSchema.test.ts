// The review methods' params: scopes, paths, paging and read sizes, checked and bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams } from '../shared/remote/schema.mjs';
import { MAX_READ, MIN_READ, DEFAULT_READ } from '../shared/remote/reviewSchema.mjs';

const bad = (method: string, params: object, message: RegExp) =>
  assert.throws(
    () => parseParams(method, params),
    (e: any) => e.code === 'invalid' && message.test(e.message),
  );

test('file.read: a read is at least a whole character wide, at most a frame-safe size, and defaults to a modest one', () => {
  const read = (maxBytes?: unknown) => (parseParams('file.read', { chatId: 'c', path: 'a', maxBytes }) as any).maxBytes;
  assert.deepEqual(
    [read(1), read(3), read(1e9), read(), read('x'), read(1000)],
    [MIN_READ, MIN_READ, MAX_READ, DEFAULT_READ, DEFAULT_READ, 1000],
  );
  assert.ok(MIN_READ >= 4 && MAX_READ <= 96 * 1024);
});

test('paths, scopes, turns, pages and old paths are checked', () => {
  bad('file.read', { chatId: 'c', path: '/etc/passwd' }, /project folder/);
  bad('file.read', { chatId: 'c', path: 'C:\\x' }, /project folder/);
  bad('file.read', { chatId: 'c', path: 'a\0b' }, /project folder/);
  bad('file.read', { chatId: 'c', path: 'x'.repeat(1001) }, /project folder/);
  bad('diff.list', { chatId: 'c', scope: 'all' }, /which changes/);
  bad('diff.list', { chatId: 'c', scope: 'turn', turnId: 'bad id' }, /turn/);
  const read = parseParams('diff.read', { chatId: 'c', path: 'a', oldPath: 'b', from: 5, rows: 5000, scope: 'turn', turnId: 't-1' }) as any;
  assert.deepEqual([read.oldPath, read.from, read.rows, read.turnId], ['b', 5, 1000, 't-1']);
  assert.equal('oldPath' in (parseParams('diff.read', { chatId: 'c', path: 'a' }) as object), false);
});

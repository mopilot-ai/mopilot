// Binary stream accumulation copies only completed reads, preserving fragmented headers and bounded bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { ByteQueue } = createRequire(import.meta.url)('../electron/transport/byteQueue.cjs');

test('empty input, contiguous views and fragmented reads preserve bytes without consuming a peek', () => {
  const q = new ByteQueue();
  q.push(Buffer.alloc(0));
  assert.deepEqual(q.take(0), Buffer.alloc(0));
  assert.equal(q.peek(1), null);
  q.push(Buffer.from('ab'));
  q.push(Buffer.from('cde'));
  assert.equal(q.peek(4).toString(), 'abcd');
  assert.equal(q.length, 5);
  assert.equal(q.take(1).toString(), 'a');
  assert.equal(q.take(6), null);
  assert.equal(q.take(3).toString(), 'bcd');
  assert.equal(q.take(1).toString(), 'e');
  assert.equal(q.length, 0);
  q.push(Buffer.from('new'));
  assert.equal(q.take(3).toString(), 'new');
});

test('many small chunks compact retired slots without changing unread bytes', () => {
  const q = new ByteQueue();
  for (let at = 0; at < 2049; at++) q.push(Buffer.from([at % 256]));
  q.discard(1025);
  assert.equal(q.head, 0);
  assert.equal(q.parts.length, 1024);
  assert.equal(q.take(1024).length, 1024);
  assert.equal(q.length, 0);
});

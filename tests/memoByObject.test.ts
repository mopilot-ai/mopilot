// src/lib/memoByObject.ts: one computation per object, kept apart per object, including results that are falsy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoByObject } from '../src/lib/memoByObject.ts';

test('each object computes once; another object computes on its own; an undefined result is kept too', () => {
  const calls: object[] = [];
  const size = memoByObject((o: { n?: number }) => (calls.push(o), o.n));
  const a = { n: 1 };
  const b = { n: 2 };
  const none = {};
  assert.equal(size(a), 1);
  assert.equal(size(a), 1);
  assert.equal(size(b), 2);
  assert.equal(size(none), undefined);
  assert.equal(size(none), undefined);
  assert.deepEqual(calls, [a, b, none]);
});

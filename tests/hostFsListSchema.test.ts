// The fs.list request on the Host wire (shared/host/schema.mjs): a path is optional (the picker starts at the Host's first root), but one that is given must be a usable path (I1, B1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';

test('fs.list takes no path, a path, and the hidden switch only when it is exactly true', () => {
  assert.deepEqual(parseParams('fs.list', {}), { hidden: false });
  assert.deepEqual(parseParams('fs.list', { path: null, hidden: 'yes' }), { hidden: false });
  assert.deepEqual(parseParams('fs.list', { path: '/home/u', hidden: true }), { path: '/home/u', hidden: true });
});

test('a path that is given must be a bounded string without a NUL', () => {
  for (const path of ['', 7, '/a\0b', `/${'x'.repeat(5000)}`]) assert.throws(() => parseParams('fs.list', { path }), /Pick a folder/);
});

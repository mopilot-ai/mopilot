// The phone's review reads: scoped change lists, paged diff rows with word spans, and paged file text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../tests/support/phone/register.ts';
const clientPath = '../mobile/src/remote/client.ts';
const reviewPath = '../mobile/src/remote/review.ts';
const client = await import(clientPath);
const review = await import(reviewPath);

const runtimeOf = (handler: (method: string, params: any) => unknown) => {
  const calls: [string, any][] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    request: async (method: string, params: any) => (calls.push([method, params]), handler(method, params)),
  };
  return { request: client.ownedRequest(runtime), calls };
};
const caps = { methods: new Set(['diff.list', 'diff.read', 'file.read']), ceiling: 'default' };
const none = { methods: new Set<string>(), ceiling: 'default' };
const change = { path: 'b.ts', oldPath: 'a.ts', status: 'renamed', binary: false, added: 1, removed: 1 };

test('changes keep well-formed files with their counts, rename source and totals', async () => {
  const { request, calls } = runtimeOf(() => ({
    files: [
      { path: 'a.ts', status: 'modified', binary: false, added: 2, removed: 1 },
      { path: 'b.ts', oldPath: 'a.ts', binary: true },
      { status: 'x' },
      null,
    ],
    total: 9,
    omitted: 3,
    truncated: true,
  }));
  const out = await review.listChanges(request, 'c', 'branch', caps);
  assert.deepEqual(calls[0], ['diff.list', { chatId: 'c', scope: 'branch' }]);
  assert.deepEqual(out.files, [
    { path: 'a.ts', oldPath: null, status: 'modified', binary: false, added: 2, removed: 1 },
    { path: 'b.ts', oldPath: 'a.ts', status: 'modified', binary: true, added: 0, removed: 0 },
  ]);
  assert.deepEqual([out.total, out.omitted, out.truncated], [9, 3, true]);
  const bare = await review.listChanges(runtimeOf(() => ({ files: [{ path: 'x' }] })).request, 'c', 'turn', null);
  assert.deepEqual([bare.total, bare.omitted, bare.truncated], [1, 0, false]);
  await assert.rejects(review.listChanges(request, 'c', 'turn', none), /Update MoPilot/);
  await assert.rejects(review.listChanges(runtimeOf(() => ({})).request, 'c', 'turn', null), /Could not read the changes/);
});

test('diff rows keep kinds, text, word spans and cut marks, and carry the page cursor', async () => {
  const { request, calls } = runtimeOf(() => ({
    binary: false,
    rows: [
      { k: 'hunk', t: '@@' },
      { k: 'del', t: 'let a', w: [4, 5] },
      { k: 'add', t: 'let b', w: [4, 5], cut: true },
      { k: 'ctx', t: 'x', w: [3, 3] },
      { k: 'ctx', t: 'y', w: ['a', 1] },
      { k: 'weird', t: 'z' },
      { k: 'add' },
      null,
    ],
    next: 400,
    total: 900,
  }));
  const page = await review.readDiff(request, 'c', change, 'uncommitted', 400, caps);
  assert.deepEqual(calls[0][1], { chatId: 'c', scope: 'uncommitted', path: 'b.ts', oldPath: 'a.ts', from: 400 });
  assert.deepEqual(
    page.rows.map((r: any) => [r.id, r.k, r.t, r.w, r.cut]),
    [
      [400, 'hunk', '@@', null, false],
      [401, 'del', 'let a', [4, 5], false],
      [402, 'add', 'let b', [4, 5], true],
      [403, 'ctx', 'x', null, false],
      [404, 'ctx', 'y', null, false],
    ],
  );
  assert.deepEqual([page.next, page.total, page.binary], [400, 900, false]);
  const end = await review.readDiff(
    runtimeOf((m, p) => (p.oldPath ? null : { binary: true, rows: [] })).request,
    'c',
    { ...change, oldPath: null },
    'turn',
    0,
    null,
  );
  assert.deepEqual([end.binary, end.next, end.total], [true, null, 0]);
  await assert.rejects(review.readDiff(request, 'c', change, 'turn', 0, none), /Update MoPilot/);
  await assert.rejects(review.readDiff(runtimeOf(() => ({})).request, 'c', change, 'turn', 0, null), /Could not read the diff/);
});

test('file pages carry the next byte offset only while the file continues', async () => {
  const { request, calls } = runtimeOf((_m, p) =>
    p.offset === 0
      ? { text: 'abc', size: 9, offset: 0, bytes: 3, truncated: true }
      : { text: 'def', size: 9, offset: 3, bytes: 3, truncated: false },
  );
  assert.deepEqual(await review.readFile(request, 'c', 'f.ts', 0, caps), { text: 'abc', size: 9, next: 3 });
  assert.deepEqual(await review.readFile(request, 'c', 'f.ts', 3, null), { text: 'def', size: 9, next: null });
  assert.deepEqual(calls[0][1], { chatId: 'c', path: 'f.ts', offset: 0 });
  const odd = await review.readFile(runtimeOf(() => ({ text: 'ab', truncated: true })).request, 'c', 'f', 5, null);
  assert.deepEqual(odd, { text: 'ab', size: 2, next: 7 });
  const stuck = await review.readFile(runtimeOf(() => ({ text: '', bytes: 0, truncated: true })).request, 'c', 'f', 0, null);
  assert.equal(stuck.next, null);
  await assert.rejects(review.readFile(request, 'c', 'f', 0, none), /Update MoPilot/);
  await assert.rejects(review.readFile(runtimeOf(() => ({})).request, 'c', 'f', 0, null), /Could not read the file/);
  await assert.rejects(review.readFile(runtimeOf(() => null).request, 'c', 'f', 0, null), /Could not read the file/);
});

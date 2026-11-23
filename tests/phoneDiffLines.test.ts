// Line numbers in a diff's gutter come from its hunk headers: removed lines count in the old file, the rest in the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/component-kit';
const linesPath = '../mobile/src/presentation/diffLines';
const { numberRows } = await import(linesPath);

const row = (id: number, k: string, t = '') => ({ id, k, t, w: null, cut: false });

test('rows are numbered from their hunk: context and added lines by the new file, removed lines by the old one', () => {
  const rows = [
    row(1, 'hunk', '@@ -3,3 +5,4 @@ function f()'),
    row(2, 'ctx', 'a'),
    row(3, 'del', 'b'),
    row(4, 'add', 'B'),
    row(5, 'add', 'C'),
    row(6, 'ctx', 'd'),
    row(7, 'meta', 'No newline at end of file'),
    row(8, 'hunk', '@@ -20 +30 @@'),
    row(9, 'del', 'x'),
    row(10, 'add', 'y'),
  ];
  assert.deepEqual(
    numberRows(rows).map((r: any) => r.line),
    [null, 5, 4, 6, 7, 8, null, null, 20, 30],
  );
});

test('rows before any readable hunk header have no number, and a later hunk starts counting again', () => {
  const rows = [
    row(1, 'ctx', 'a'),
    row(2, 'del', 'b'),
    row(3, 'add', 'c'),
    row(4, 'hunk', 'not a header'),
    row(5, 'ctx', 'd'),
    row(6, 'hunk', '@@ -1 +1 @@'),
    row(7, 'ctx', 'e'),
  ];
  assert.deepEqual(
    numberRows(rows).map((r: any) => r.line),
    [null, null, null, null, null, null, 1],
  );
});

test('diffs and counts are set in the platform’s monospace face', async () => {
  const fontsPath = '../mobile/src/fonts';
  const { monoFamily } = await import(fontsPath);
  const g = globalThis as any;
  try {
    g.__phonePlatform = 'ios';
    assert.equal(monoFamily(), 'Menlo');
    g.__phonePlatform = 'android';
    assert.equal(monoFamily(), 'monospace');
  } finally {
    delete g.__phonePlatform;
  }
});

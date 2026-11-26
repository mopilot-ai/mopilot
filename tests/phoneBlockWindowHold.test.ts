// A block window that loses its first block keeps its place (#5686): when the first mounted block is replaced or folded into a run, the window starts at the next block that was there, so the blocks above a reader stay mounted in place, and only a window with nothing left of what it showed starts again from the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const windowPath = '../mobile/src/remote/useBlockWindow';
const { windowStart, blockKey, WINDOW } = await import(windowPath);

const row = (key: string) => ({ type: 'row', row: { key, role: 'user', text: key } });
const blocks = (keys: string[]) => keys.map(row) as any[];
const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `k${from + i}`);

test('a window whose first block is gone starts at the next block that was there, not at the end', () => {
  const was = names(300);
  const before = windowStart(blocks(was), null);
  assert.equal(before.from, 300 - WINDOW);
  const anchor = before.anchor;
  assert.equal(anchor, 'k180');
  // k180 and k181 fold into one run, which is a new key; everything else is as it was
  const now = ['k0', ...names(179, 1), 'run:a', ...names(118, 182)];
  const kept = windowStart(blocks(now), anchor, WINDOW, blocks(was));
  assert.equal(kept.anchor, 'k182', 'the first surviving block after the gone one');
  assert.equal(blockKey(blocks(now)[kept.from]), 'k182', 'and the window starts there, so the rows above the reader stay where they are');
  assert.notEqual(kept.from, Math.max(0, now.length - WINDOW), 'not from the end');
});

test('a window with nothing left of what it showed starts again from the end, as before, and so does one that never knew its blocks', () => {
  const was = names(300);
  const anchor = windowStart(blocks(was), null).anchor;
  const replaced = names(300, 1000);
  assert.equal(windowStart(blocks(replaced), anchor, WINDOW, blocks(was)).from, 300 - WINDOW);
  assert.equal(windowStart(blocks(replaced), anchor).from, 300 - WINDOW, 'no keys known: from the end');
  // the gone block was the last one known: nothing after it to hold on to
  assert.equal(windowStart(blocks(names(200)), 'k300', WINDOW, blocks([...was, 'k300'])).from, 200 - WINDOW);
});

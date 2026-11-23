// src/components/sidebar/chatWindow.ts: how far a folded sidebar list shows its chats, as Claude Code's sidebar does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWindow } from '../src/components/sidebar/chatWindow.ts';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
const none = (r: number) => r < 0;
const at = (i: number) => (r: number) => r === i;
const view = (n: number, revealed: number, isOpen = none) => {
  const w = chatWindow(rows(n), 5, revealed, isOpen);
  return { shown: w.visible.length, foot: w.foot, more: w.more };
};

test('a list never folds away a single chat', () => {
  assert.deepEqual(view(5, 0), { shown: 5, foot: null, more: 0 });
  assert.deepEqual(view(6, 0), { shown: 6, foot: null, more: 0 });
  assert.deepEqual(view(7, 0), { shown: 5, foot: { kind: 'more', count: 2 }, more: 2 });
});

test('Show more reveals five at a time, then the rest, and Show less folds back once all are shown', () => {
  assert.deepEqual(view(19, 0), { shown: 5, foot: { kind: 'more', count: 5 }, more: 5 });
  assert.deepEqual(view(19, 5), { shown: 10, foot: { kind: 'more', count: 5 }, more: 10 });
  // fewer than five are left: the last page takes them all
  assert.deepEqual(view(19, 10), { shown: 15, foot: { kind: 'more', count: 4 }, more: 14 });
  assert.deepEqual(view(19, 14), { shown: 19, foot: { kind: 'less' }, more: 14 });
  // a page that would leave one behind takes it too
  assert.deepEqual(view(11, 0), { shown: 5, foot: { kind: 'more', count: 6 }, more: 6 });
  assert.deepEqual(view(11, 6), { shown: 11, foot: { kind: 'less' }, more: 6 });
});

test('a list that lost chats after Show more still offers Show less, and none once nothing would fold', () => {
  assert.deepEqual(view(8, 10), { shown: 8, foot: { kind: 'less' }, more: 10 });
  assert.deepEqual(view(6, 10), { shown: 6, foot: null, more: 10 });
});

test('the open chat stretches the list to reach it, and holds Show less while folding would hide nothing', () => {
  // open below the fold: the list reaches it and the rest stay behind Show more
  assert.deepEqual(view(19, 0, at(10)), { shown: 11, foot: { kind: 'more', count: 5 }, more: 11 });
  assert.deepEqual(view(19, 0, at(15)), { shown: 16, foot: { kind: 'more', count: 3 }, more: 14 });
  // open above the fold: no change
  assert.deepEqual(view(19, 0, at(2)), { shown: 5, foot: { kind: 'more', count: 5 }, more: 5 });
  // fully shown, Show less folds back to the open chat
  assert.deepEqual(view(19, 14, at(10)), { shown: 19, foot: { kind: 'less' }, more: 14 });
  // open so near the end that folding to it would hide at most one chat: Show less is held
  assert.deepEqual(view(19, 14, at(17)), { shown: 19, foot: { kind: 'held' }, more: 14 });
  // never revealed: no row at all, though every chat shows to reach the open one
  assert.deepEqual(view(19, 0, at(17)), { shown: 19, foot: null, more: 0 });
});

test('a held Show less needs a list long enough to fold at all', () => {
  assert.deepEqual(view(6, 3, at(5)), { shown: 6, foot: null, more: 3 });
});

test('every required chat stays above the fold, even when the first match is already visible', () => {
  const required = (row: number) => [1, 8, 12].includes(row);
  assert.deepEqual(view(19, 0, required), { shown: 13, foot: { kind: 'more', count: 6 }, more: 14 });
  assert.deepEqual(view(19, 14, required), { shown: 19, foot: { kind: 'less' }, more: 14 });
  assert.deepEqual(
    view(19, 14, (row) => row === 1 || row === 17),
    { shown: 19, foot: { kind: 'held' }, more: 14 },
  );
});

// Tool arrangements retain distinct resource slots, focused replacement and bounded per-chat sizes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { act } from 'react';
import {
  projectToolLayout,
  splitToolLayout,
  singleToolLayout,
  removeToolTile,
  resizeToolPair,
  toolLayout,
  rememberToolLayout,
  resetToolLayouts,
  toolLayoutScope,
  useToolLayout,
  type ToolLayout,
} from '../src/lib/toolPaneLayout.ts';
beforeEach(resetToolLayouts);
const one = (): ToolLayout => projectToolLayout(toolLayout('a'), ['a', 'b', 'c', 'd', 'e'], 'a');

test('a window starts with its selected tool; unavailable/duplicate slots are removed and weights repaired', () => {
  assert.deepEqual(one(), { ids: ['a'], active: 'a', axis: 'rows', weights: [1] });
  assert.equal(projectToolLayout(one(), ['a'], 'a').active, 'a');
  const bad: ToolLayout = {
    ids: ['a', 'a', 'gone', 'b', 'c', 'd', 'e'],
    active: 'gone',
    axis: 'columns',
    weights: [NaN, 9, 1, -2, Infinity, 0, 3],
  };
  assert.deepEqual(projectToolLayout(bad, ['a', 'b', 'c', 'd', 'e'], 'b'), {
    ids: ['a', 'b', 'c', 'd'],
    active: 'b',
    axis: 'columns',
    weights: [1, 1, 1, 1],
  });
  assert.deepEqual(projectToolLayout(one(), [], ''), { ids: [], active: '', axis: 'rows', weights: [] });
  assert.equal(projectToolLayout(one(), ['a'], 'foreign').active, 'a');
});

test('splits add distinct tabs after the focused one and stop at four without duplicating a resource', () => {
  let s = one();
  for (const id of ['b', 'c', 'd']) s = splitToolLayout(s, id, 'columns');
  assert.deepEqual(s.ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(s.weights, [0.25, 0.25, 0.25, 0.25], 'consecutive opens leave each default tool a usable average share');
  assert.equal(splitToolLayout(s, 'e', 'rows'), s);
  assert.equal(splitToolLayout(one(), 'a', 'rows').ids.length, 1);
  assert.equal(splitToolLayout(one(), '', 'rows').ids.length, 1);
  assert.equal(splitToolLayout(toolLayout('empty'), 'a', 'rows').ids.length, 0);
  assert.deepEqual(splitToolLayout({ ...one(), active: 'absent', weights: [NaN] }, 'b', 'rows').weights, [0.5, 0.5]);
});

test('selecting another visible tile only focuses; selecting an unseen tab replaces the focused slot', () => {
  const s = splitToolLayout(one(), 'b', 'rows');
  const focused = projectToolLayout(s, ['a', 'b', 'c'], 'a');
  assert.deepEqual(focused.ids, ['a', 'b']);
  const replaced = projectToolLayout(focused, ['a', 'b', 'c'], 'c');
  assert.deepEqual(replaced.ids, ['c', 'b']);
  assert.deepEqual(replaced.weights, [0.5, 0.5]);
  assert.equal(projectToolLayout(replaced, ['b', 'c'], 'c'), replaced);
  assert.deepEqual(projectToolLayout({ ...s, active: 'absent' }, ['a', 'b', 'c'], 'c').ids, ['c', 'b']);
});

test('removing a selected tile focuses its neighbor; one-pane mode preserves the selected tab', () => {
  const pair = splitToolLayout(one(), 'b', 'columns');
  assert.deepEqual(removeToolTile(pair, 'b').ids, ['a']);
  assert.equal(removeToolTile(pair, 'b').active, 'a');
  assert.equal(removeToolTile(pair, 'a').active, 'b');
  assert.equal(removeToolTile(pair, 'missing'), pair);
  const s = one();
  assert.equal(removeToolTile(s, 'a'), s);
  assert.deepEqual(singleToolLayout(pair), { ids: ['b'], active: 'b', axis: 'columns', weights: [1] });
  assert.deepEqual(singleToolLayout(toolLayout('empty')).ids, []);
});

test('a divider keeps the pair’s combined weight, other sizes, finite values and bounded ends', () => {
  const s: ToolLayout = { ids: ['a', 'b', 'c'], weights: [0.5, 0.25, 0.25], active: 'c', axis: 'rows' };
  const moved = resizeToolPair(s, 0, 0.6).weights;
  assert.ok(Math.abs(moved[0] - 0.45) < 1e-12);
  assert.ok(Math.abs(moved[1] - 0.3) < 1e-12);
  assert.equal(moved[2], 0.25);
  assert.equal(resizeToolPair(s, -1, 0.5), s);
  assert.equal(resizeToolPair(s, 2, 0.5), s);
  assert.equal(resizeToolPair(s, 0, NaN), s);
  assert.deepEqual(resizeToolPair({ ...s, weights: [NaN, -1, 0.25] }, 0, -2).weights, [0.2, 1.8, 0.25]);
  assert.deepEqual(resizeToolPair(s, 1, 4).weights, [0.5, 0.45, 0.04999999999999999]);
});

test('layouts are distinct per stable chat/home, retained across views, bounded, and observed only while mounted', async () => {
  assert.notEqual(toolLayoutScope(null), toolLayoutScope('home'));
  const a = toolLayoutScope('a'),
    b = toolLayoutScope('b');
  const values: string[] = [];
  function Probe() {
    const s = useToolLayout(a);
    values.push(s.ids.join(','));
    return h('i', null, s.ids.join(','));
  }
  const v = await render(h(Probe));
  const s = one();
  await act(() => rememberToolLayout(a, s));
  assert.equal(v.host.textContent, 'a');
  const renders = values.length;
  await act(() => rememberToolLayout(a, { ...s }));
  assert.equal(values.length, renders);
  await act(() => rememberToolLayout(b, splitToolLayout(s, 'b', 'rows')));
  assert.equal(toolLayout(a), s);
  await act(resetToolLayouts);
  assert.equal(v.host.textContent, '', 'a window reset clears a mounted tool view');
  const resetRenders = values.length;
  await v.unmount();
  for (let i = 0; i < 101; i++) rememberToolLayout(`other-${i}`, s);
  assert.deepEqual(toolLayout(a).ids, []);
  assert.deepEqual(toolLayout('other-0').ids, [], 'the oldest of more than 100 remembered chats is evicted');
  assert.equal(toolLayout('other-100'), s, 'the newest chat stays available');
  assert.equal(values.length, resetRenders);
  resetToolLayouts();
  assert.deepEqual(toolLayout(b).ids, []);
});

test('closing the selected tab fills its retired slot without replacing another visible tool', () => {
  const pair = splitToolLayout(one(), 'b', 'rows');
  const next = projectToolLayout(pair, ['a', 'c'], 'c');
  assert.deepEqual(next.ids, ['a', 'c']);
  assert.deepEqual(next.weights, [0.5, 0.5]);
});

test('a malformed oversized layout cannot regain a fifth slot while filling a retired selection', () => {
  const saved = { ids: ['a', 'b', 'c', 'd', 'e'], weights: [1, 1, 1, 1, 1], active: 'e', axis: 'rows' } as const;
  const s = projectToolLayout(saved, ['a', 'b', 'c', 'd', 'e'], 'e');
  assert.equal(s.ids.length, 4);
  assert.ok(s.ids.includes('e'));
});

test('a new tool gets an average share while existing user-resized tools retain their relative proportions', () => {
  const pair: ToolLayout = { ids: ['a', 'b'], active: 'a', weights: [3, 1], axis: 'rows' };
  const next = splitToolLayout(pair, 'c', 'rows');
  assert.deepEqual(next.ids, ['a', 'c', 'b']);
  assert.ok(Math.abs(next.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  assert.ok(Math.abs(next.weights[0] / next.weights[2] - 3) < 1e-12);
  assert.equal(next.weights[1], 1 / 3);
});

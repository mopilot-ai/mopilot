// Sidebar family grouping is comparator-driven, one visual level, and resilient to missing, detached and cyclic lineage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarFamilies } from '../src/lib/sidebarFamilies.ts';

const link = (parentId: string, detached = false) => ({ parentId, detached }) as never;

test('the best sorted member positions the root and siblings retain comparator order in depth-first family rows', () => {
  const view = { children: { c: link('p'), g: link('c'), b: link('p'), orphan: link('gone'), detached: link('p', true) } } as never;
  const grouped = sidebarFamilies(view, ['g', 'other', 'b', 'p', 'c', 'orphan', 'detached', 'g']);
  assert.deepEqual(grouped.roots, ['p', 'other', 'orphan', 'detached']);
  assert.deepEqual(grouped.descendants.get('p'), ['b', 'c', 'g']);
  assert.deepEqual(grouped.descendants.get('other'), []);
  assert.deepEqual(sidebarFamilies(view, []).roots, []);
});

test('self ancestry, cycles and children of cycles never hide or duplicate a listed chat', () => {
  const view = { children: { self: link('self'), a: link('b'), b: link('a'), child: link('a') } } as never;
  const grouped = sidebarFamilies(view, ['self', 'a', 'b', 'child']);
  assert.deepEqual(grouped.roots, ['self', 'a', 'b', 'child']);
  assert.ok([...grouped.descendants.values()].every((rows) => rows.length === 0));
});

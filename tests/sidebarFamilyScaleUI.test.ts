// src/lib/sidebarFamilyIndex.ts: the sidebar builds its family index once per change of the chat list, not once per row
// per store write, and a family list re-renders only for its own members' state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, fx, thread, mountSidebar, flush, update, getState } from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { familiesOf, familyBuilds } = await import('../src/lib/sidebarFamilyIndex.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const ids = Array.from({ length: 200 }, (_, i) => `c${i}`);
const link = (parentId: string, createdAt: number) => ({ parentId, name: 'n', title: 'n', harness: null, useWorktree: false, createdAt });

function mount200() {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  const threads = Object.fromEntries(ids.map((id, i) => [id, thread(id, { updatedAt: 500 - i })]));
  reset({ threadOrder: ids, threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  // every fifth chat starts the four after it
  const children: Record<string, unknown> = {};
  ids.forEach((id, i) => {
    if (i % 5) children[id] = link(`c${i - (i % 5)}`, i);
  });
  fx.orchestration = { children, deliveries: {}, proposals: {}, queue: [] };
  return mountSidebar();
}

test('200 chats: unrelated store writes do not rebuild the family index (before: one rebuild per row per write)', async (t) => {
  const view = await mount200();
  t.after(() => view.unmount());
  await flush();
  assert.equal(view.host.querySelectorAll('[data-sidebar-chat]').length > 10, true);
  assert.equal(familyBuilds.count > 0, true);
  const before = familyBuilds.count;
  for (let n = 0; n < 5; n++) {
    await update({ ...getState(), runtime: { ...getState().runtime, c7: { turns: [{ items: [], n }] } }, unread: { c9: n % 2 === 0 } });
  }
  assert.equal(familyBuilds.count, before, 'runtime and unread writes leave the chat list alone');
  // a change of the list itself rebuilds once, however many rows read it
  await update({ ...getState(), threadOrder: [...ids].reverse() });
  assert.equal(familyBuilds.count - before <= 2, true, 'one rebuild per mode, not one per row');
});

test('the shared index follows each input and both orders', () => {
  const view = { children: { b: link('a', 1) }, deliveries: {}, proposals: {}, queue: [] } as never;
  const threads = { a: thread('a', { updatedAt: 1 }), b: thread('b', { updatedAt: 9 }), m: thread('m') } as never;
  const order = ['a', 'b', 'm', 'gone'];
  const momo = { m: true } as never;
  const stored = familiesOf(view, order, threads, momo, false);
  assert.deepEqual(stored.roots, ['a']);
  assert.equal(familiesOf(view, order, threads, momo, false), stored, 'same identities hit the cache');
  const sorted = familiesOf(view, order, threads, momo, true);
  assert.deepEqual(sorted.descendants.get('a'), ['b']);
  assert.notEqual(familiesOf(view, [...order], threads, momo, false), stored, 'a new order rebuilds');
});

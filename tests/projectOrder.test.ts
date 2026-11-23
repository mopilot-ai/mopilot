import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { loadPrefs } from '../src/store/types.ts';
import { Sidebar, setFixture, baseState, render } from './support/shell-sidebar-kit.ts';

// Exercise the real grouping hook with an in-memory store and inert persistence (rendered in the client: the hook follows main's chat list).
const { useProjectGroups } = Sidebar;

async function groups(prefs: Record<string, unknown> = {}, newerRecency = 20, hydrate = true) {
  setFixture({
    ...baseState(),
    prefs: hydrate ? loadPrefs(prefs) : prefs,
    home: '/home',
    segments: {},
    worktreeOf: {},
    savedProjects: ['older', 'newer', 'empty'].map((id) => ({ id, name: id, roots: [{ path: `/work/${id}` }] })),
    threadOrder: ['old-chat', 'new-chat', 'newer-old-chat', 'folder-chat'],
    threads: {
      'old-chat': { id: 'old-chat', projectId: 'older', updatedAt: 4, recencyAt: 10 },
      'new-chat': { id: 'new-chat', projectId: 'newer', updatedAt: 1, recencyAt: newerRecency },
      'newer-old-chat': { id: 'newer-old-chat', projectId: 'newer', updatedAt: 5 },
      'folder-chat': { id: 'folder-chat', cwd: '/work/folder', updatedAt: 15 },
    },
  });
  let result: any;
  function Probe() {
    result = useProjectGroups();
    return null;
  }
  const view = await render(createElement(Probe));
  await view.unmount();
  return result.groups as { id: string | null; path: string; threads: { id: string }[] }[];
}
const keys = (value: Awaited<ReturnType<typeof groups>>) => value.map((g) => g.id ?? g.path);

test('default project order follows chat recency instead of saved project placement', async () => {
  const prefs = { sidebarProjectOrder: ['older', 'empty', 'newer', '/work/folder'] };
  assert.deepEqual(keys(await groups(prefs)), ['newer', '/work/folder', 'older', 'empty']);
  assert.deepEqual(keys(await groups(prefs, 8)), ['/work/folder', 'older', 'newer', 'empty']);
  // The hook also defaults to recent activity before preferences are hydrated.
  assert.deepEqual(keys(await groups(prefs, 20, false)), ['newer', '/work/folder', 'older', 'empty']);
});

test('manual chat order does not change project recency and pins remain first', async () => {
  const sorted = await groups({ chatSort: 'manual', chatOrder: { newer: ['newer-old-chat', 'new-chat'] }, pinnedProjects: ['older'] });
  assert.deepEqual(keys(sorted), ['older', 'newer', '/work/folder', 'empty']);
  assert.deepEqual(
    sorted.find((g) => g.id === 'newer')!.threads.map((t) => t.id),
    ['newer-old-chat', 'new-chat'],
  );
});

test('explicit custom and alphabetical project order remain available', async () => {
  assert.deepEqual(keys(await groups({ projectSort: 'custom', sidebarProjectOrder: ['empty', 'older', '/work/folder', 'newer'] })), [
    'empty',
    'older',
    '/work/folder',
    'newer',
  ]);
  assert.deepEqual(keys(await groups({ projectSort: 'name' })), ['empty', '/work/folder', 'newer', 'older']);
});

test('a project with more chats than a function argument limit remains sortable in the sidebar', async () => {
  const threads = Object.fromEntries(
    Array.from({ length: 150000 }, (_, i) => [`chat-${i}`, { id: `chat-${i}`, projectId: 'large', updatedAt: i }]),
  );
  setFixture({
    ...baseState(),
    savedProjects: [
      { id: 'empty', name: 'Empty', roots: [{ path: '/empty' }] },
      { id: 'large', name: 'Large', roots: [{ path: '/large' }] },
    ],
    threads,
    threadOrder: Object.keys(threads),
  });
  let result: any;
  function Probe() {
    result = useProjectGroups();
    return null;
  }
  const view = await render(createElement(Probe));
  await view.unmount();
  assert.deepEqual(keys(result.groups), ['large', 'empty']);
  assert.equal(result.groups[0].threads.length, 150000);
  assert.equal(result.groups[0].threads[0], threads['chat-149999']);
});

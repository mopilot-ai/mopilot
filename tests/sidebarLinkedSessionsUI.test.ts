// src/components/sidebar/ChildRows.tsx and projectGroups.ts: a chat another listed chat started shows nested under
// it (indented with a tree line, its own badges), not as a top-level row; with its parent gone or archived it is top-level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { reset, fx, thread, mountSidebar, flush, update, getState, key, fire } from './support/shell-sidebar-kit.ts';

// after the kit's mocks: the real module would read the real bridge
const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
const { numberedSidebarChat } = await import('../src/session/sidebarShortcuts.tsx');
// boot has told main this window is ready, as in a window that finished starting
markWindowReady();

const child = (parentId: string, name: string, createdAt: number) => ({
  parentId,
  name,
  title: name,
  harness: 'codex',
  useWorktree: true,
  createdAt,
  lastReport: null,
});

function linked(queue: string[] = []) {
  return {
    queue,
    children: {
      kid2: child('top', 'kid2', 2),
      kid1: child('top', 'kid1', 1),
      grand: child('kid1', 'grand', 3),
      lost: child('gone', 'lost', 4),
    },
    deliveries: {},
    proposals: {},
  };
}

test('children nest under their parent in order, grandchildren under them; a child whose parent is not listed stays top-level', async (t) => {
  resetSideSessions();
  const threads = Object.fromEntries(
    ['top', 'kid1', 'kid2', 'grand', 'lost', 'other'].map((id, i) => [id, thread(id, { cwd: '/home', updatedAt: 20 - i })]),
  );
  reset({ threadOrder: Object.keys(threads), threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  fx.orchestration = linked();
  const view = await mountSidebar();
  await flush();
  const recents = view.host;
  const topLevel = () =>
    [...recents.querySelectorAll('.thread-row')].filter((r) => !r.closest('.side-children')).map((r) => r.getAttribute('aria-label'));
  const top = topLevel();
  assert.deepEqual(top, ['Chat top', 'Chat lost', 'Chat other']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await key(document.body, 'Meta', { metaKey: true });
  await act(async () => t.mock.timers.tick(500));
  assert.deepEqual(
    view.$$('.chat-shortcut-hint').map((el) => el.textContent),
    ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6'],
  );
  assert.equal(
    numberedSidebarChat('chat-3', () => []),
    'grand',
  );
  await fire(document.body, new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
  const nested = [...recents.querySelectorAll('.side-children .thread-row')] as HTMLElement[];
  assert.deepEqual(
    nested.map((r) => [r.getAttribute('aria-label'), r.style.getPropertyValue('--depth'), r.className]),
    [
      ['Chat kid1', '1', 'side-row thread-row linked-child'],
      ['Chat grand', '1', 'side-row thread-row linked-child'],
      ['Chat kid2', '1', 'side-row thread-row linked-child'],
    ],
  );
  // archiving the parent (it leaves the list) brings its children to the top level
  await update({ ...getState(), threadOrder: ['kid1', 'kid2', 'grand', 'lost', 'other'] });
  await flush();
  const after = topLevel();
  assert.deepEqual(after, ['Chat kid1', 'Chat kid2', 'Chat lost', 'Chat other']);
  assert.equal(recents.querySelector('.side-children .thread-row')?.getAttribute('aria-label'), 'Chat grand');
  // a nested chat the window doesn't list (archived) is left out
  fx.orchestrationChanged({ ...linked(), children: { ...linked().children, ghost: child('kid1', 'ghost', 9) } });
  await flush();
  assert.equal(recents.querySelectorAll('.side-children .thread-row').length, 1);
  await view.unmount();
});

test('nested rows also show under a project’s chat and in the one-list view; a chat that started none renders nothing more', async () => {
  resetSideSessions();
  const threads = { top: thread('top', { cwd: '/work/a' }), kid1: thread('kid1', { cwd: '/work/a', updatedAt: 9 }) };
  reset({ threadOrder: ['top', 'kid1'], threads, prefs: { sidebarFolders: ['/work/a'], sidebarProjectOrder: ['/work/a'] } });
  fx.orchestration = { children: { kid1: child('top', 'kid1', 1) }, deliveries: {}, proposals: {}, queue: [] };
  const view = await mountSidebar();
  await flush();
  const nested = [...view.host.querySelectorAll('.side-children .thread-row.indent.linked-child')] as HTMLElement[];
  assert.ok(
    nested.some((r) => r.getAttribute('aria-label') === 'Chat kid1'),
    'nested under the project’s chat, indented',
  );
  await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
  await flush();
  assert.ok([...view.host.querySelectorAll('.side-children .thread-row')].some((r) => r.getAttribute('aria-label') === 'Chat kid1'));
  await view.unmount();
});

test('a chat whose parent row is not shown (a hidden or sub-agent chat), or whose links loop, stays at the top level', async () => {
  resetSideSessions();
  const threads = {
    hiddenParent: thread('hiddenParent', { cwd: '/home', ephemeral: true }),
    orphan: thread('orphan', { cwd: '/home', updatedAt: 9 }),
    a: thread('a', { cwd: '/home', updatedAt: 8 }),
    b: thread('b', { cwd: '/home', updatedAt: 7 }),
  };
  reset({ threadOrder: Object.keys(threads), threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  fx.orchestration = {
    children: { orphan: child('hiddenParent', 'orphan', 1), a: child('b', 'a', 2), b: child('a', 'b', 3) },
    deliveries: {},
    proposals: {},
    queue: [],
  };
  const view = await mountSidebar();
  await flush();
  const top = [...view.host.querySelectorAll('.thread-row')]
    .filter((r) => !r.closest('.side-children'))
    .map((r) => r.getAttribute('aria-label'));
  assert.deepEqual(top, ['Chat orphan', 'Chat a', 'Chat b']);
  // Cyclic provenance cannot duplicate a listed chat under another row.
  assert.equal(view.host.querySelectorAll('.side-children .thread-row').length, 0);
  await view.unmount();
});

test('a nested session with retained input identifies its receiving session', async () => {
  resetSideSessions();
  const threads = Object.fromEntries(
    ['top', 'kid1', 'kid2', 'grand'].map((id, i) => [id, thread(id, { cwd: '/home', updatedAt: 20 - i })]),
  );
  reset({ threadOrder: Object.keys(threads), threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  fx.orchestration = linked(['kid2', 'grand']);
  const view = await mountSidebar();
  await flush();
  const badge = (label: string) =>
    [...view.host.querySelectorAll('.thread-row')].find((r) => r.getAttribute('aria-label') === label)!.querySelector('.side-row-queued');
  assert.equal(badge('Chat kid2')?.getAttribute('title'), 'Queued for this session');
  assert.equal(badge('Chat grand')?.getAttribute('title'), 'Queued for this session');
  assert.equal(badge('Chat kid1'), null);
  assert.equal(badge('Chat top'), null);
  // a waiting session shown at the top level (its parent no longer listed) says so too
  await update({ ...getState(), threadOrder: ['kid1', 'kid2', 'grand'] });
  await flush();
  const kid2 = [...view.host.querySelectorAll('.thread-row')].find((r) => r.getAttribute('aria-label') === 'Chat kid2')!;
  assert.equal(kid2.closest('.side-children'), null);
  assert.ok(kid2.querySelector('.side-row-queued'));
  await view.unmount();
});

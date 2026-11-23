// src/components/sidebar/projectGroups.ts: chats grouped into projects, folders and Recents, the custom project and
// manual chat orders, and reordering chats and projects by dragging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  Sidebar,
  calls,
  fx,
  reset,
  render,
  getState,
  update,
  click,
  drag,
  thread,
  project,
  named,
  prefsCalls,
  mountSidebar,
  label,
  probe,
} from './support/shell-sidebar-kit.ts';

test('chats group into saved projects, worktrees, folders and Recents, and new folders are remembered', async () => {
  reset({
    home: '/home',
    savedProjects: [
      project('p1', '/work/p1', 'api'),
      { id: 'p2', name: 'Empty', roots: [] },
      project('p3', '/repos/sage', 'sage'),
      project('t1', '/t/twin', 'twin'),
      project('t2', '/t/Twin', 'twin'),
    ],
    segments: { a: [{ nativeId: 'a' }, { nativeId: 'k' }] },
    worktreeOf: { b: '/work/p1', c: '/nowhere' },
    threadOrder: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'missing', 'l', 'm'],
    threads: {
      a: thread('a', { projectId: 'p1', updatedAt: 50 }),
      b: thread('b', { cwd: '/wt/b', updatedAt: 40, recencyAt: 90 }),
      c: thread('c', { cwd: '/nowhere', updatedAt: 30 }),
      d: thread('d', { cwd: '/home/.codex/worktrees/abc/sage', updatedAt: 20 }),
      e: thread('e', { cwd: '/home/.codex/worktrees/abc/unknown', updatedAt: 19 }),
      f: thread('f', { cwd: undefined, updatedAt: 18 }),
      g: thread('g', { cwd: '/work/gone', updatedAt: 17 }),
      h: thread('h', { cwd: '/other/x/api', updatedAt: 16 }),
      i: thread('i', { parentThreadId: 'a' }),
      j: thread('j', { ephemeral: true }),
      k: thread('k'),
      l: thread('l', { cwd: '/a/same/dup', updatedAt: 5 }),
      m: thread('m', { cwd: '/b/same/dup', updatedAt: 4 }),
    },
    prefs: {
      sidebarFolders: ['/work/hidden', '/work/p1', '/work/kept'],
      hiddenFolders: ['/work/hidden', '/work/gone'],
      folderNames: { '/work/kept': 'Kept folder' },
      // pinned, so the two twins are listed with no chat and tell themselves apart
      pinnedProjects: ['t1', 't2'],
    },
  });
  const { get, view } = await probe();
  const { groups, listed, recents } = get();
  const byKey = Object.fromEntries(groups.map((g: any) => [label(g), g]));
  assert.deepEqual(
    byKey.p1.threads.map((t: any) => t.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    byKey.p3.threads.map((t: any) => t.id),
    ['d'],
  );
  assert.equal(byKey.p2.path, '');
  assert.deepEqual(
    byKey['/nowhere'].threads.map((t: any) => t.id),
    ['c'],
  );
  assert.equal(byKey['/work/kept'].name, 'Kept folder');
  assert.equal(byKey['/work/hidden'], undefined);
  // the sidebar lists the groups with chats and the pinned ones, not the empty project or the remembered folder
  assert.deepEqual(listed.map(label).sort(), ['/a/same/dup', '/b/same/dup', '/nowhere', '/other/x/api', 'p1', 'p3', 't1', 't2']);
  // Same names show parent folders, deep enough to tell them apart (or as deep as allowed).
  assert.deepEqual([byKey.p1.hint, byKey['/other/x/api'].hint], ['work', 'x']);
  assert.deepEqual([byKey['/a/same/dup'].hint, byKey['/b/same/dup'].hint], ['a/same', 'b/same']);
  assert.deepEqual([byKey.t1.hint, byKey.t2.hint], ['t', 't']);
  assert.equal(byKey.p3.hint, undefined);
  // Recents holds every chat by recency, including the ones that belong to no group.
  assert.deepEqual(
    recents.map((t: any) => t.id),
    ['b', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'l', 'm'],
  );
  // Folders and order keys seen for the first time are saved once.
  const saved = prefsCalls();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].sidebarFolders, [
    '/work/hidden',
    '/work/p1',
    '/work/kept',
    '/nowhere',
    '/other/x/api',
    '/a/same/dup',
    '/b/same/dup',
  ]);
  assert.deepEqual(saved[0].sidebarProjectOrder.slice().sort(), groups.map(label).sort());
  await view.unmount();
});

test("one folder group for macOS's /private/tmp and /tmp spellings, and hiding one hides both", async () => {
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: ['x1', 'x2', 'y1'],
    threads: {
      x1: thread('x1', { cwd: '/private/tmp/x', updatedAt: 3 }),
      x2: thread('x2', { cwd: '/tmp/x', updatedAt: 2 }),
      y1: thread('y1', { cwd: '/private/tmp/y', updatedAt: 1 }),
    },
    prefs: { sidebarFolders: ['/tmp/x'], hiddenFolders: ['/tmp/y'] },
  });
  const { get, view } = await probe();
  const { groups } = get();
  assert.deepEqual(
    groups.map((g: any) => [g.path, g.threads.map((t: any) => t.id)]),
    [['/tmp/x', ['x1', 'x2']]],
  );
  await view.unmount();
});

test('custom project order appends unknown keys, and manual chat order keeps new chats on top', async () => {
  reset({
    savedProjects: [project('a'), project('b'), project('c')],
    threadOrder: ['x', 'y', 'z'],
    threads: {
      x: thread('x', { projectId: 'a', updatedAt: 3 }),
      y: thread('y', { projectId: 'a', updatedAt: 2 }),
      z: thread('z', { projectId: 'b', updatedAt: 1 }),
    },
    prefs: {
      projectSort: 'custom',
      sidebarProjectOrder: ['b', 'a'],
      sidebarFolders: [],
      chatSort: 'manual',
      chatOrder: { a: ['y'], '@recents': ['z', 'x'] },
    },
  });
  const { get, view } = await probe();
  assert.deepEqual(get().groups.map(label), ['b', 'a', 'c']);
  assert.deepEqual(
    get().groups[1].threads.map((t: any) => t.id),
    ['x', 'y'],
  );
  assert.deepEqual(
    get().recents.map((t: any) => t.id),
    ['y', 'z', 'x'],
  );
  assert.deepEqual(prefsCalls(), [{ sidebarFolders: [], sidebarProjectOrder: ['b', 'a', 'c'] }]);
  await view.unmount();
  reset({ savedProjects: [project('a')], prefs: { chatSort: 'manual', sidebarFolders: [], sidebarProjectOrder: ['a'] } });
  const again = await probe();
  assert.deepEqual(again.get().recents, []);
  assert.deepEqual(prefsCalls(), []);
  await again.view.unmount();
});

test('starting a turn promotes its refreshed recency in recent sorting while manual sorting stays fixed', async () => {
  reset({
    savedProjects: [project('p')],
    threadOrder: ['idle', 'working'],
    threads: {
      idle: thread('idle', { projectId: 'p', updatedAt: 20, recencyAt: 20 }),
      working: thread('working', { projectId: 'p', updatedAt: 10, recencyAt: 10 }),
    },
    prefs: { chatSort: 'updated', sidebarFolders: [], sidebarProjectOrder: ['p'] },
  });
  const { get, view } = await probe();
  assert.deepEqual(
    get().groups[0].threads.map((t: any) => t.id),
    ['idle', 'working'],
  );
  await update({
    ...getState(),
    threadOrder: ['working', 'idle'],
    threads: {
      ...getState().threads,
      working: { ...getState().threads.working, updatedAt: 30, recencyAt: 30 },
    },
  });
  assert.deepEqual(
    get().groups[0].threads.map((t: any) => t.id),
    ['working', 'idle'],
  );
  assert.deepEqual(
    get().recents.map((t: any) => t.id),
    ['working', 'idle'],
  );
  await update({ ...getState(), prefs: { ...getState().prefs, chatSort: 'manual', chatOrder: { p: ['idle', 'working'] } } });
  assert.deepEqual(
    get().groups[0].threads.map((t: any) => t.id),
    ['idle', 'working'],
  );
  await view.unmount();
});

test('dragging chats reorders them manually, snapshotting the current order first', async () => {
  reset({
    savedProjects: [project('p1')],
    threadOrder: ['a', 'b', 'c', 'r'],
    threads: {
      a: thread('a', { projectId: 'p1', updatedAt: 3 }),
      b: thread('b', { projectId: 'p1', updatedAt: 2 }),
      c: thread('c', { projectId: 'p1', updatedAt: 1 }),
      r: thread('r', { cwd: '/home', updatedAt: 0 }),
    },
    pinned: { a: true },
    prefs: { chatOrder: { other: ['z'] }, sidebarFolders: [], sidebarProjectOrder: ['p1'] },
  });
  const view = await mountSidebar();
  const rows = () => view.$('.project-group').querySelectorAll('.sidebar-chat-drag');
  const start = await drag(rows()[0], 'dragstart');
  assert.deepEqual(start.data, { 'text/x-codex-thread': 'a' });
  assert.equal(start.dt.effectAllowed, 'move');
  // Only chat drags are accepted.
  const ignored = await drag(rows()[2], 'dragover', { types: ['Files'] });
  assert.equal(ignored.defaultPrevented, false);
  const over = await drag(rows()[2], 'dragover', { types: ['text/x-codex-thread'], clientY: 5 });
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dt.dropEffect, 'move');
  assert.match(rows()[2].className, /drag-over drag-after/);
  await drag(rows()[2], 'dragleave');
  assert.doesNotMatch(rows()[2].className, /drag-over/);
  await drag(rows()[2], 'dragover', { types: ['text/x-codex-thread'], clientY: 0 });
  assert.match(rows()[2].className, /drag-over $/);
  await drag(rows()[2], 'dragend');
  assert.doesNotMatch(rows()[2].className, /drag-over/);
  // Dropping a chat on itself changes nothing.
  await drag(rows()[0], 'drop', { data: { 'text/x-codex-thread': 'a' } });
  assert.deepEqual(prefsCalls(), []);
  await drag(rows()[2], 'drop', { data: { 'text/x-codex-thread': 'a' }, clientY: 5 });
  const [first] = prefsCalls();
  assert.equal(first.chatSort, 'manual');
  assert.deepEqual(first.chatOrder, {
    other: ['z'],
    p1: ['b', 'c', 'a'],
    '@recents': ['a', 'b', 'c', 'r'],
    '@pinned': ['a'],
    '@list': ['a', 'b', 'c'],
  });
  // Once manual, the existing order is kept as is.
  calls.length = 0;
  await drag(rows()[0], 'drop', { data: { 'text/x-codex-thread': 'c' }, clientY: 0 });
  assert.deepEqual(prefsCalls()[0].chatOrder, {
    other: ['z'],
    p1: ['c', 'b', 'a'],
    '@recents': ['a', 'b', 'c', 'r'],
    '@pinned': ['a'],
    '@list': ['a', 'b', 'c'],
  });
  // Unknown ids are ignored.
  calls.length = 0;
  await drag(rows()[0], 'drop', { data: { 'text/x-codex-thread': 'nope' } });
  assert.deepEqual(prefsCalls(), []);
  await view.unmount();
});

test('dragging projects sets a custom order and moves saved projects', async () => {
  reset({
    savedProjects: [project('p1'), project('p2')],
    threadOrder: ['f', 'a', 'b'],
    threads: { f: thread('f', { cwd: '/work/folder' }), a: thread('a', { projectId: 'p1' }), b: thread('b', { projectId: 'p2' }) },
    prefs: { sidebarFolders: ['/work/folder'], sidebarProjectOrder: ['p1', 'p2', '/work/folder', 'stale'], projectSort: 'custom' },
  });
  const view = await mountSidebar();
  const rows = () => view.$$('.project-row');
  assert.deepEqual(
    rows().map((r) => r.querySelector('.side-row-label')!.textContent),
    ['p1', 'p2', 'folder'],
  );
  const start = await drag(rows()[0], 'dragstart');
  assert.deepEqual(start.data, { 'text/x-codex-project': 'p1' });
  assert.equal((await drag(rows()[1], 'dragover', { types: ['text/x-codex-thread'] })).defaultPrevented, false);
  assert.equal((await drag(rows()[1], 'dragover', { types: ['text/x-codex-project'], clientY: 3 })).defaultPrevented, true);
  assert.match(rows()[1].className, /drag-over drag-after/);
  await drag(rows()[1], 'dragleave');
  assert.doesNotMatch(rows()[1].className, /drag-over/);
  await drag(rows()[1], 'drop', { data: { 'text/x-codex-project': 'p1' }, clientY: 3 });
  assert.deepEqual(prefsCalls(), [{ projectSort: 'custom', sidebarProjectOrder: ['p2', 'p1', '/work/folder', 'stale'] }]);
  assert.deepEqual(named('toast'), []);
  assert.deepEqual(named('moveProject'), [['p1', null]]);
  // A folder group moves without touching saved projects; switching from another sort says so.
  // (With persistence lagging, there is no saved order yet to append.)
  fx.applyPrefs = false;
  await update({ ...getState(), prefs: { ...getState().prefs, projectSort: 'name', sidebarProjectOrder: undefined } });
  calls.length = 0;
  assert.deepEqual(
    rows().map((r) => r.querySelector('.side-row-label')!.textContent),
    ['folder', 'p1', 'p2'],
  );
  await drag(rows()[1], 'drop', { data: { 'text/x-codex-project': '/work/folder' }, clientY: 0 });
  assert.deepEqual(prefsCalls(), [{ projectSort: 'custom', sidebarProjectOrder: ['/work/folder', 'p1', 'p2'] }]);
  assert.deepEqual(named('toast'), [['Project order set to Custom']]);
  assert.deepEqual(named('moveProject'), []);
  calls.length = 0;
  await drag(rows()[2], 'drop', { data: { 'text/x-codex-project': 'p1' }, clientY: 0 });
  assert.deepEqual(named('moveProject'), [['p1', 'p2']]);
  calls.length = 0;
  await drag(rows()[0], 'drop', { data: { 'text/x-codex-project': 'missing' } });
  assert.deepEqual(prefsCalls(), []);
  await view.unmount();
});

test('folder groups show parent hints, start chats in their folder, and sort by path in custom order', async () => {
  reset({
    savedProjects: [project('p1', '/work/api', 'api')],
    threadOrder: ['f', 'u', 'w', 'z'],
    threads: {
      f: thread('f', { cwd: '/other/api' }),
      u: thread('u', { cwd: '/home' }),
      w: thread('w', { projectId: 'p1' }),
      z: thread('z', { cwd: '/z/zz' }),
    },
    unread: { u: true },
    activityView: true,
    prefs: { projectSort: 'custom', sidebarFolders: ['/z/zz'], sidebarProjectOrder: ['/other/api', 'p1'] },
  });
  const view = await render(h(Sidebar.Sidebar, { leaving: true, width: 300 }));
  assert.match(view.$('aside').className, /leaving/);
  // A thread with no preview and no reply shows an empty snippet.
  assert.equal(view.$('.priority-snippet').textContent, '');
  await click(view.$('[aria-label="View activity"]'));
  // Unranked groups follow the custom order.
  assert.deepEqual(
    view.$$('.project-row .side-row-label').map((e) => e.textContent),
    ['api · other', 'api · work', 'zz'],
  );
  await click(view.$('[aria-label="New chat in api"]'));
  assert.deepEqual(getState().newChatProjectId, null);
  assert.deepEqual(getState().newChatCwd, '/other/api');
  assert.deepEqual(getState().route, { name: 'home', cwd: '/other/api' });
  await view.unmount();
});

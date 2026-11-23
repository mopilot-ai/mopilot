// src/components/sidebar/projectGroups.ts and Sidebar.tsx: the sidebar lists a project or folder only while it has an active or starting chat, as Claude Code's drops a folder whose sessions are all archived; a pinned one stays, and so does the home page's, where the new chat goes (picked or by default), its current row.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  fx,
  reset,
  getState,
  update,
  flush,
  click,
  drag,
  thread,
  project,
  named,
  prefsCalls,
  mountSidebar,
  byText,
  mouse,
} from './support/shell-sidebar-kit.ts';
import { useChatStarts, showChatStart } from '../src/lib/chatStarts.ts';

const names = (view: { $$: (sel: string) => Element[] }) => view.$$('.project-row .side-row-label').map((e) => e.textContent);
/** The project row marked current (the home page's, or none), whether New chat is, and whether the list offers a folder. */
const current = (view: { $: (sel: string) => Element | null }) => view.$('.project-row.selected .side-row-label')?.textContent ?? null;
const newChatCurrent = (view: { $: (sel: string) => Element | null }) =>
  /selected-soft/.test(view.$('.sidebar-nav > .side-row')!.className);
const offersFolder = (view: { $$: (sel: string) => Element[] }) =>
  view.$$('.side-row-label').some((e) => e.textContent === 'Add a project folder');
/** The chat leaves the window's chats, as archiving it does; restoring puts it back. */
const without = (id: string) => {
  const { [id]: _gone, ...threads } = getState().threads;
  return { ...getState(), threads, threadOrder: getState().threadOrder.filter((x: string) => x !== id) };
};

test('archiving the last chat drops a project or folder from the sidebar, and restoring one returns it in its custom place', async () => {
  const chats = {
    a: thread('a', { projectId: 'p1', updatedAt: 4 }),
    b: thread('b', { projectId: 'p2', updatedAt: 3 }),
    c: thread('c', { projectId: 'p3', updatedAt: 2 }),
    f: thread('f', { cwd: '/work/folder', updatedAt: 1 }),
  };
  reset({
    savedProjects: [project('p1', '/work/alpha', 'Alpha'), project('p2', '/work/beta', 'Beta'), project('p3', '/work/gamma', 'Gamma')],
    threadOrder: ['a', 'b', 'c', 'f'],
    threads: chats,
    prefs: { projectSort: 'custom', sidebarFolders: ['/work/folder'], sidebarProjectOrder: ['p1', 'p2', 'p3', '/work/folder'] },
  });
  const view = await mountSidebar();
  try {
    assert.deepEqual(names(view), ['Alpha', 'Beta', 'Gamma', 'folder']);
    await update(without('b'));
    await update(without('f'));
    await flush();
    assert.deepEqual(names(view), ['Alpha', 'Gamma']);
    // the folder is still remembered, only not listed
    assert.deepEqual(getState().prefs.sidebarFolders, ['/work/folder']);
    // dragging Alpha after Gamma leaves the unlisted Beta before Gamma, where it was
    const rows = () => view.$$('.project-row');
    await drag(rows()[1], 'drop', { data: { 'text/x-codex-project': 'p1' }, clientY: 3 });
    assert.deepEqual(prefsCalls().at(-1)!.sidebarProjectOrder, ['p2', 'p3', 'p1', '/work/folder']);
    assert.deepEqual(named('moveProject'), [['p1', null]]);
    assert.deepEqual(names(view), ['Gamma', 'Alpha']);
    // restoring a chat lists its project again, in its place
    await update({ ...getState(), threads: { ...getState().threads, b: chats.b }, threadOrder: [...getState().threadOrder, 'b'] });
    await flush();
    assert.deepEqual(names(view), ['Beta', 'Gamma', 'Alpha']);
  } finally {
    await view.unmount();
  }
});

test('a pinned project or folder stays listed with no chat, and an unlisted one adds no parent folder to a listed one of its name', async () => {
  reset({
    savedProjects: [project('p1', '/work/api', 'api')],
    threadOrder: ['o'],
    threads: { o: thread('o', { cwd: '/other/api' }) },
    route: { name: 'thread', id: 'o' },
    prefs: { sidebarFolders: ['/z/kept'], sidebarProjectOrder: ['p1', '/z/kept', '/other/api'], pinnedProjects: ['/z/kept'] },
  });
  const view = await mountSidebar();
  try {
    // off the home page the empty api project is not listed, so the folder of that name needs no parent to tell them apart
    assert.deepEqual(names(view), ['kept', 'api']);
    const kept = byText(view.host, '.project-row .side-row-label', 'kept').closest('.project-group')!;
    assert.ok(byText(kept, '.empty-note', 'No active chats'));
    assert.ok(byText(kept, '.show-more', 'View archived chats'));
    // pinned, the empty project is listed too, and the two of one name show their parents
    await update({ ...getState(), prefs: { ...getState().prefs, pinnedProjects: ['/z/kept', 'p1'] } });
    await flush();
    assert.deepEqual(names(view), ['api · work', 'kept', 'api · other']);
  } finally {
    await view.unmount();
  }
});

test('the Projects list offers to add a folder only while no project is saved, and the added project is listed while its first chat is written', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1', 'Quiet')],
    route: { name: 'thread', id: 'x' },
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1'] },
  });
  const view = await mountSidebar();
  try {
    // a saved project with no chat, off the home page: not listed, and nothing offers a folder while one is saved
    assert.deepEqual(names(view), []);
    assert.equal(offersFolder(view), false);
    await update({ ...getState(), savedProjects: [] });
    await flush();
    fx.openFolder = '/work/new';
    await click(byText(view.host, '.side-row-label', 'Add a project folder'));
    // main saves the project and the window hears of it; the new chat is to start in it
    await update({ ...getState(), savedProjects: [project('p-new', '/work/new', 'new')] });
    await flush();
    assert.deepEqual(named('createProject'), [['/work/new']]);
    assert.deepEqual(names(view), ['new']);
    // leaving the new chat unwritten leaves the empty project out again
    await update({ ...getState(), route: { name: 'thread', id: 'x' } });
    await flush();
    assert.deepEqual(names(view), []);
  } finally {
    await view.unmount();
  }
});

test('the project or folder picked for a new chat is listed while that chat is written, by any of its saved ids', async () => {
  reset({
    savedProjects: [project('busy', '/work/busy', 'Busy'), project('old', '/link/sage', 'Sage'), project('new', '/real/sage', 'Sage')],
    threadOrder: ['b'],
    threads: { b: thread('b', { projectId: 'busy' }) },
    route: { name: 'thread', id: 'b' },
    prefs: { sidebarFolders: ['/work/kept'], sidebarProjectOrder: ['busy', 'old', '/work/kept'] },
  });
  // the two saved Sage projects are one folder by two paths: one row for both
  fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link/sage' ? '/real/sage' : p]));
  const view = await mountSidebar();
  const pick = async (over: Record<string, unknown>) => {
    await update({ ...getState(), route: { name: 'home' }, newChatProjectId: null, newChatCwd: null, newChatHost: null, ...over });
    await flush();
  };
  try {
    assert.deepEqual(names(view), ['Busy']);
    // picked by the id of the row's other saved alias
    await pick({ newChatProjectId: 'new' });
    assert.deepEqual(names(view), ['Busy', 'Sage']);
    await pick({ newChatProjectId: 'none' });
    assert.deepEqual(names(view), ['Busy']);
    // a remembered folder picked for the chat
    await pick({ newChatCwd: '/work/kept' });
    assert.deepEqual(names(view), ['Busy', 'kept']);
    // nothing picked: the chat starts in the newest chat's project, already listed
    await pick({});
    assert.deepEqual(names(view), ['Busy']);
    await pick({ newChatProjectId: 'old' });
    assert.deepEqual(names(view), ['Busy', 'Sage']);
    await update({ ...getState(), route: { name: 'thread', id: 'b' } });
    await flush();
    assert.deepEqual(names(view), ['Busy']);
  } finally {
    await view.unmount();
  }
});

test('a pin on any saved alias or folder spelling survives the last archive and restart, and Unpin clears every equivalent pin', async () => {
  for (const pins of [['new'], ['/link/sage'], ['/real/sage'], ['old', 'new', '/link/sage', '/real/sage']]) {
    reset({
      savedProjects: [project('busy', '/work/busy', 'Busy'), project('old', '/link/sage', 'Sage'), project('new', '/real/sage', 'Sage')],
      threadOrder: ['b', 'a'],
      threads: { b: thread('b', { projectId: 'busy', updatedAt: 20 }), a: thread('a', { projectId: 'new', updatedAt: 1 }) },
      route: { name: 'thread', id: 'b' },
      prefs: { sidebarProjectOrder: ['busy', 'old', 'new'], pinnedProjects: pins },
    });
    fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link/sage' ? '/real/sage' : p]));
    let view = await mountSidebar();
    try {
      await update(without('a'));
      await flush();
      assert.deepEqual(names(view), ['Sage', 'Busy'], `retained pins: ${pins}`);
      const persisted = getState();
      await view.unmount();
      reset(persisted);
      fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link/sage' ? '/real/sage' : p]));
      view = await mountSidebar();
      assert.deepEqual(names(view), ['Sage', 'Busy']);
      assert.deepEqual(getState().prefs.pinnedProjects, pins, 'reading an alias does not rewrite the saved pin');
      await mouse(view.$$('.project-row')[0], 'contextmenu');
      await click(byText(view.$('[data-menu]'), 'button', 'Unpin'));
      await flush();
      assert.deepEqual(getState().prefs.pinnedProjects, []);
      assert.deepEqual(names(view), ['Busy']);
    } finally {
      await view.unmount();
    }
  }
});

test('a pinned folder remains listed after import saves its canonical project, and its hover card can unpin it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let view: Awaited<ReturnType<typeof mountSidebar>> | undefined;
  try {
    reset({
      threadOrder: ['a'],
      threads: { a: thread('a', { cwd: '/link/sage' }) },
      route: { name: 'thread', id: 'a' },
      prefs: { sidebarFolders: ['/link/sage'], pinnedProjects: ['/link/sage'] },
    });
    fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link/sage' ? '/real/sage' : p]));
    view = await mountSidebar();
    await update(without('a'));
    await update({ ...getState(), savedProjects: [project('saved', '/real/sage', 'Saved')] });
    await flush();
    assert.deepEqual(names(view), ['Saved']);
    await mouse(view.$('.project-row'), 'mouseover');
    await act(async () => mock.timers.tick(600));
    await flush();
    assert.match(view.$('.project-card .menu-pin').className, /on/);
    await click(view.$('.project-card .menu-pin'));
    assert.deepEqual(getState().prefs.pinnedProjects, []);
    assert.deepEqual(names(view), []);
  } finally {
    await view?.unmount();
    mock.timers.reset();
  }
});

test('an explicit folder pick follows canonical identity when saved or remembered aliases represent its empty group', async () => {
  for (const saved of [true, false]) {
    reset({
      savedProjects: saved ? [project('saved', '/real/sage', 'Sage')] : [],
      route: { name: 'home' },
      newChatProjectId: null,
      newChatCwd: '/link/sage',
      prefs: { sidebarFolders: saved ? [] : ['/real/sage', '/link/sage'] },
    });
    const requested: string[][] = [];
    fx.canonicalPaths = async (paths) => {
      requested.push(paths);
      return Object.fromEntries(paths.map((p) => [p, p === '/link/sage' ? '/real/sage' : p]));
    };
    const view = await mountSidebar();
    try {
      assert.deepEqual(names(view), [saved ? 'Sage' : 'sage']);
      assert.ok(
        requested.some((paths) => paths.includes('/link/sage')),
        'the selected local folder participates in canonical resolution',
      );
      await update({ ...getState(), newChatProjectId: 'none' });
      await flush();
      assert.deepEqual(names(view), []);
    } finally {
      await view.unmount();
    }
  }
});

test('saved projects, no chats, on the home page with nothing picked: its project is listed as the current row, not New chat', async () => {
  reset({
    savedProjects: [project('p1', '/work/alpha', 'Alpha'), project('p2', '/work/beta', 'Beta')],
    route: { name: 'home' },
    newChatProjectId: null,
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1', 'p2'] },
  });
  // with no chat, newChatProject's default is the first saved project (its own test: homeTarget.test.ts)
  const view = await mountSidebar();
  const at = async (over: Record<string, unknown>) => {
    await update({ ...getState(), ...over });
    await flush();
  };
  try {
    assert.deepEqual(names(view), ['Alpha']);
    assert.equal(current(view), 'Alpha');
    assert.equal(newChatCurrent(view), false);
    assert.equal(offersFolder(view), false);
    // another project picked is the row now; the default one, with no chat, leaves
    await at({ newChatProjectId: 'p2' });
    assert.deepEqual(names(view), ['Beta']);
    assert.equal(current(view), 'Beta');
    // a chat outside any project (the top New chat): no project row, New chat is the current one, and no folder is offered
    await at({ newChatProjectId: 'none' });
    assert.deepEqual(names(view), []);
    assert.equal(newChatCurrent(view), true);
    assert.equal(offersFolder(view), false);
    await at({ newChatProjectId: null });
    assert.deepEqual(names(view), ['Alpha']);
    assert.equal(current(view), 'Alpha');
    // the one-list view draws no project rows, so New chat is the home page's current entry there
    await at({ prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
    assert.equal(current(view), null);
    assert.equal(newChatCurrent(view), true);
    await at({ prefs: { ...getState().prefs, sidebarOrganize: 'project' } });
    // nor does the activity view, which lists chats by what they need instead of the Projects list
    await at({ activityView: true });
    assert.equal(newChatCurrent(view), true);
    await at({ activityView: false });
    assert.equal(current(view), 'Alpha');
    assert.equal(newChatCurrent(view), false);
    // off the home page a project with no chat is not listed
    await at({ route: { name: 'projects' } });
    assert.deepEqual(names(view), []);
    assert.equal(current(view), null);
  } finally {
    await view.unmount();
  }
});

test("a chat started in the home page's project keeps its row while it starts, on its own page, and after a failed start", async () => {
  useChatStarts.setState([], true);
  reset({
    savedProjects: [project('p1', '/work/alpha', 'Alpha')],
    route: { name: 'home' },
    newChatProjectId: null,
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1'] },
  });
  const view = await mountSidebar();
  try {
    assert.deepEqual(names(view), ['Alpha']);
    // as the send does it (store/chatCreation.ts): the start shows, the chat is made and opened, then the start goes
    let finish = () => {};
    await act(async () => {
      finish = showChatStart('Plan it', { cwd: '/work/alpha', projectId: 'p1' });
    });
    assert.deepEqual(names(view), ['Alpha']);
    await update({
      ...getState(),
      threads: { c1: thread('c1', { projectId: 'p1' }) },
      threadOrder: ['c1'],
      route: { name: 'thread', id: 'c1' },
    });
    assert.deepEqual(names(view), ['Alpha']);
    await act(async () => finish());
    await flush();
    assert.deepEqual(names(view), ['Alpha']);
    // a start that fails leaves the user on the home page, and the row with it
    await update({ ...getState(), threads: {}, threadOrder: [], route: { name: 'home' } });
    await act(async () => {
      finish = showChatStart('Fails', { cwd: '/work/alpha', projectId: 'p1' });
    });
    await act(async () => finish());
    await flush();
    assert.deepEqual(names(view), ['Alpha']);
    assert.equal(current(view), 'Alpha');
  } finally {
    await view.unmount();
  }
});

test("the home page marks its row however it was picked: by the row's other saved id, or by another spelling of its folder", async () => {
  reset({
    savedProjects: [project('busy', '/work/busy', 'Busy'), project('old', '/link/sage', 'Sage'), project('new', '/real/sage', 'Sage')],
    threadOrder: ['b'],
    threads: { b: thread('b', { projectId: 'busy' }) },
    route: { name: 'home' },
    newChatProjectId: null,
    prefs: { sidebarFolders: ['/real/kept'], sidebarProjectOrder: ['busy', 'old', '/real/kept'] },
  });
  // the two saved Sage projects are one folder by two paths, so one row, 'old', for both; /link/kept is /real/kept
  fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p.replace('/link/', '/real/')]));
  const view = await mountSidebar();
  try {
    await flush();
    // nothing picked: the newest chat's project
    assert.equal(current(view), 'Busy');
    await update({ ...getState(), newChatProjectId: 'new' });
    await flush();
    assert.deepEqual(names(view), ['Busy', 'Sage']);
    assert.equal(current(view), 'Sage');
    await update({ ...getState(), newChatProjectId: null, newChatCwd: '/link/kept' });
    await flush();
    assert.deepEqual(names(view), ['Busy', 'kept']);
    assert.equal(current(view), 'kept');
  } finally {
    await view.unmount();
  }
});

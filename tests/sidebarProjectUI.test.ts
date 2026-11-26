// src/components/sidebar/ProjectGroup.tsx and SidebarSections.tsx: the sidebar options, section labels, and a
// project's row, actions menu, renaming and hover card.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  calls,
  reset,
  getState,
  update,
  click,
  key,
  mouse,
  blur,
  focus,
  flush,
  thread,
  project,
  named,
  prefsCalls,
  mountSidebar,
  byText,
} from './support/shell-sidebar-kit.ts';

test('sidebar options switch organization, project order, chat order and harness icons', async () => {
  reset({ prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  const view = await mountSidebar();
  const menu = () => view.$('[data-menu]');
  const open = () => click(view.$('[aria-label="Project sidebar options"]'));
  const checked = async () => {
    await open();
    const out = [...menu().querySelectorAll('[data-checked="true"]')].map((e) => e.textContent);
    await click(menu().querySelector('[data-close]')!);
    return out;
  };
  assert.deepEqual(await checked(), ['By project', 'Custom', 'Last updated']);
  for (const item of [
    'In one list',
    'By project',
    'Custom',
    'Recent activity',
    'Name',
    'Manual order',
    'Last updated',
    'Show harness icons',
  ]) {
    await open();
    await click(byText(menu(), 'button', item));
  }
  assert.deepEqual(prefsCalls(), [
    { sidebarOrganize: 'list' },
    { sidebarOrganize: 'project' },
    { projectSort: 'custom' },
    { projectSort: 'updated' },
    { projectSort: 'name' },
    { chatSort: 'manual' },
    { chatSort: 'updated' },
    { showChatHarness: true },
  ]);
  assert.deepEqual(await checked(), ['By project', 'Name', 'Last updated', 'Show harness icons']);
  await open();
  await click(byText(menu(), 'button', 'Show harness icons'));
  assert.equal(getState().prefs.showChatHarness, false);
  await view.unmount();
});

test('section labels rename inline and can be removed', async () => {
  reset({
    savedProjects: [project('p1'), project('p2')],
    prefs: {
      sidebarSections: [
        { id: 's1', name: 'Work' },
        { id: 's2', name: 'Other' },
      ],
      projectSection: { p1: 's1', p2: 's1' },
      sidebarFolders: [],
      sidebarProjectOrder: ['p1', 'p2'],
    },
  });
  const view = await mountSidebar();
  await mouse(byText(view.host, '.side-section-label', 'Work'), 'dblclick');
  assert.equal(getState().renamingSection, 's1');
  let input = view.$('.side-section-input') as HTMLInputElement;
  input.value = 'Workspace';
  await focus(input);
  await key(input, 'x');
  await key(input, 'Enter');
  await blur(input);
  assert.equal(getState().renamingSection, null);
  assert.deepEqual(
    getState().prefs.sidebarSections.map((s: any) => s.name),
    ['Workspace', 'Other'],
  );

  calls.length = 0;
  await update({ ...getState(), renamingSection: 's1' });
  await flush();
  input = view.$('.side-section-input') as HTMLInputElement;
  input.value = '   ';
  await blur(input);
  assert.deepEqual(prefsCalls(), []);
  await update({ ...getState(), renamingSection: 's1' });
  await flush();
  await key(view.$('.side-section-input'), 'Escape');
  assert.equal(getState().renamingSection, null);

  await click(view.$('[aria-label="Remove section"]'));
  assert.deepEqual(getState().prefs.sidebarSections, [{ id: 's2', name: 'Other' }]);
  assert.deepEqual(getState().prefs.projectSection, {});
  await view.unmount();
});

test('a project row toggles, opens its menu, starts chats and shows more chats', async () => {
  const threads = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`c${i}`, thread(`c${i}`, { projectId: 'p1', updatedAt: 20 - i })]),
  );
  reset({
    savedProjects: [project('p1', '/work/p1', 'Proj'), project('p2', '/work/p2', 'Bare')],
    threadOrder: Object.keys(threads),
    threads,
    route: { name: 'thread', id: 'c8' },
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1', 'p2'] },
  });
  const view = await mountSidebar();
  await flush();
  const row = () => view.$$('.project-row')[0];
  const group = () => view.$$('.project-group')[0];
  // The list stretches to the open chat beyond the fold; the rest stay behind "Show 3 more".
  const shown = () => [...group().querySelectorAll('.thread-row .side-row-label')].map((e) => e.textContent);
  const foot = () => group().querySelector<HTMLElement>('.show-more');
  assert.deepEqual(
    shown(),
    Array.from({ length: 9 }, (_, i) => `Chat c${i}`),
  );
  assert.equal(foot()!.getAttribute('aria-label'), 'Show 3 more in Proj');
  await click(byText(group(), '.show-more', 'Show 3 more'));
  assert.deepEqual(getState().revealedChats, { p1: 7 });
  assert.equal(shown().length, 12);
  assert.equal(foot()!.getAttribute('aria-label'), 'Show less in Proj');
  await click(byText(group(), '.show-more', 'Show less'));
  assert.deepEqual(getState().revealedChats, { p1: 0 });
  assert.equal(shown().length, 9);

  // Opening a chat near the end holds Show less: folding back would hide nothing.
  await click(byText(group(), '.show-more', 'Show 3 more'));
  await update({ ...getState(), route: { name: 'thread', id: 'c11' } });
  await flush();
  assert.equal(shown().length, 12);
  assert.equal(foot()!.getAttribute('aria-disabled'), 'true');
  assert.equal(foot()!.title, 'You have a session open or active near the end of this list.');
  assert.equal(foot()!.getAttribute('aria-label'), 'Show less in Proj. You have a session open or active near the end of this list.');
  await click(foot()!);
  assert.deepEqual(getState().revealedChats, { p1: 7 });

  await click(row());
  assert.deepEqual(getState().collapsedProjects, { p1: true });
  assert.equal(shown().length, 0);
  await click(row());
  assert.deepEqual(getState().collapsedProjects, { p1: false });

  calls.length = 0;
  await click(view.$('[aria-label="New chat in Proj"]'));
  assert.deepEqual(named('setState').at(-1), [{ newChatProjectId: 'p1', newChatCwd: null }]);
  assert.deepEqual(getState().route, { name: 'home', cwd: '/work/p1' });
  assert.equal(getState().collapsedProjects.p1, false);

  // An empty project is not listed; pinned, it is, and offers a new chat or the archive.
  assert.equal(view.$$('.project-group').length, 1);
  await update({ ...getState(), prefs: { ...getState().prefs, pinnedProjects: ['p2'] } });
  await flush();
  const bare = byText(view.host, '.project-row .side-row-label', 'Bare').closest('.project-group')!;
  assert.ok(byText(bare, '.empty-note', 'No active chats'));
  await click(byText(bare, '.show-more', 'New chat'));
  assert.deepEqual(getState().route, { name: 'home', cwd: '/work/p2' });
  await click(byText(bare, '.show-more', 'View archived chats'));
  assert.deepEqual(getState().route, { name: 'settings', section: 'archived' });
  await update({ ...getState(), prefs: { ...getState().prefs, pinnedProjects: [] } });
  await flush();
  assert.equal(view.$$('.project-group').length, 1);

  // The ellipsis toggles the actions menu without toggling the project; right-click opens it too.
  await click(row().querySelector('[data-tooltip="Project actions"] button')!);
  assert.match(row().className, /menu-open/);
  assert.equal(getState().collapsedProjects.p1, false);
  await click(view.$('[data-menu] [data-close]'));
  assert.equal(view.$('[data-menu]'), null);
  await mouse(row(), 'contextmenu');
  assert.ok(view.$('[data-menu]'));
  await view.unmount();
});

test('the project actions menu pins, renames, sections, reveals, archives and removes', async () => {
  const confirm = mock.fn((_: string) => true);
  (globalThis as any).confirm = confirm;
  reset({
    savedProjects: [project('p1', '/work/p1', 'Proj')],
    threadOrder: ['a', 'b'],
    threads: { a: thread('a', { projectId: 'p1' }), b: thread('b', { projectId: 'p1' }) },
    prefs: { sidebarFolders: ['/work/empty'], sidebarProjectOrder: ['p1', '/work/empty'], sidebarSections: [{ id: 's1', name: 'Work' }] },
  });
  const view = await mountSidebar();
  const openMenu = async (name = 'Proj') => {
    await mouse(byText(view.host, '.project-row .side-row-label', name).closest('.project-row')!, 'contextmenu');
    return view.$('[data-menu]');
  };
  const select = async (text: string, name = 'Proj') => click(byText(await openMenu(name), 'button', text));
  await select('Pin');
  assert.deepEqual(getState().prefs.pinnedProjects, ['p1']);
  await select('Unpin');
  assert.deepEqual(getState().prefs.pinnedProjects, []);

  // Sections: assign, unassign, create.
  assert.ok((await openMenu()).querySelector('[data-submenu="Section"] hr'));
  await select('Work');
  assert.deepEqual(getState().prefs.projectSection, { p1: 's1' });
  assert.equal(byText(await openMenu(), 'button', 'Work').getAttribute('data-checked'), 'true');
  await select('Work');
  assert.deepEqual(getState().prefs.projectSection, {});
  const random = mock.method(Math, 'random', () => 0.5);
  await select('New section…');
  random.mock.restore();
  const id = (0.5).toString(36).slice(2, 8);
  assert.deepEqual(getState().prefs.sidebarSections, [
    { id: 's1', name: 'Work' },
    { id, name: 'New section' },
  ]);
  assert.deepEqual(getState().prefs.projectSection, { p1: id });
  assert.equal(getState().renamingSection, id);
  await update({ ...getState(), renamingSection: null, prefs: { ...getState().prefs, sidebarSections: [], projectSection: {} } });
  assert.equal((await openMenu()).querySelector('[data-submenu="Section"] hr'), null);

  await select('Reveal in Finder');
  assert.deepEqual(named('openPath'), [['/work/p1']]);

  // Archive asks first.
  confirm.mock.mockImplementationOnce(() => false);
  await select('Archive chats');
  await flush();
  assert.deepEqual(named('archive'), []);
  await select('Archive chats');
  await flush();
  assert.deepEqual(named('archive'), [['a'], ['b']]);
  assert.deepEqual(named('toast'), [['Archived 2 chats']]);
  assert.equal(confirm.mock.calls.at(-1)!.arguments[0], 'Archive all 2 chats in Proj?');

  // An empty folder group (listed while pinned) archives nothing and has no section submenu.
  confirm.mock.resetCalls();
  await update({ ...getState(), prefs: { ...getState().prefs, pinnedProjects: ['/work/empty'] } });
  await flush();
  const folderMenu = await openMenu('empty');
  assert.equal(folderMenu.querySelector('[data-submenu="Section"]'), null);
  await click(byText(folderMenu, 'button', 'Archive chats'));
  assert.equal(confirm.mock.callCount(), 0);

  // Removing a folder only hides it, after confirming.
  confirm.mock.mockImplementationOnce(() => false);
  await select('Remove from sidebar', 'empty');
  assert.equal(getState().prefs.hiddenFolders, undefined);
  await select('Remove from sidebar', 'empty');
  assert.deepEqual(getState().prefs.hiddenFolders, ['/work/empty']);
  assert.equal(confirm.mock.calls.at(-1)!.arguments[0], 'Remove empty from Projects? Its chats move to Recents and stay in your history.');

  // Removing a saved project hides its folder and deletes it, after confirming.
  confirm.mock.mockImplementationOnce(() => false);
  await select('Remove from sidebar');
  assert.deepEqual(named('deleteProject'), []);
  await select('Remove from sidebar');
  assert.deepEqual(named('deleteProject'), [['p1']]);
  assert.deepEqual(getState().prefs.hiddenFolders, ['/work/empty', '/work/p1']);
  assert.equal(confirm.mock.calls.at(-1)!.arguments[0], 'Remove Proj from the sidebar? Chats stay in your history.');
  await view.unmount();

  // Hidden folders default to none.
  reset({
    savedProjects: [project('p1')],
    threadOrder: ['a'],
    threads: { a: thread('a', { projectId: 'p1' }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1'] },
  });
  const again = await mountSidebar();
  await mouse(again.$('.project-row'), 'contextmenu');
  await click(byText(again.$('[data-menu]'), 'button', 'Remove from sidebar'));
  assert.deepEqual(getState().prefs.hiddenFolders, ['/work/p1']);
  await again.unmount();
});

test('renaming a project saves saved-project names and folder names', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1', 'Proj')],
    threadOrder: ['a', 'f'],
    threads: { a: thread('a', { projectId: 'p1', updatedAt: 2 }), f: thread('f', { cwd: '/work/folder', updatedAt: 1 }) },
    prefs: { sidebarFolders: ['/work/folder'], sidebarProjectOrder: ['p1', '/work/folder'] },
  });
  const view = await mountSidebar();
  const rename = async (i: number, value: string, how: 'blur' | 'Enter' | 'Escape' = 'blur') => {
    await mouse(view.$$('.project-row')[i], 'contextmenu');
    await click(byText(view.$('[data-menu]'), 'button', 'Edit'));
    const input = view.$('.rename-input') as HTMLInputElement;
    await click(input);
    input.value = value;
    await key(input, 'x');
    if (how === 'blur') await blur(input);
    else await key(input, how);
    if (how === 'Enter') await blur(input);
  };
  const before = getState().collapsedProjects;
  await rename(0, '  ');
  await rename(0, 'Proj');
  await rename(0, 'Escape me', 'Escape');
  assert.equal(view.$('.rename-input'), null);
  assert.deepEqual(named('renameProject'), []);
  await rename(0, ' Renamed ', 'Enter');
  assert.deepEqual(named('renameProject'), [['p1', 'Renamed']]);
  assert.equal(getState().collapsedProjects, before);
  await rename(1, 'My folder');
  assert.deepEqual(getState().prefs.folderNames, { '/work/folder': 'My folder' });
  await rename(1, 'Again');
  assert.deepEqual(getState().prefs.folderNames, { '/work/folder': 'Again' });
  await view.unmount();
});

test('hovering a project shows its card with pin, path and edit actions', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    reset({
      savedProjects: [project('p1', '/work/p1', 'Proj')],
      threadOrder: ['a', 'f', 't1', 't2'],
      threads: {
        a: thread('a', { projectId: 'p1', updatedAt: 4 }),
        f: thread('f', { cwd: '/work/folder', updatedAt: 3 }),
        t1: thread('t1', { cwd: '/work/two', updatedAt: 2 }),
        t2: thread('t2', { cwd: '/work/two', updatedAt: 1 }),
      },
      prefs: { sidebarFolders: ['/work/folder', '/work/two'], sidebarProjectOrder: ['p1', '/work/folder', '/work/two'], folderNames: {} },
    });
    const view = await mountSidebar();
    const row = view.$$('.project-row')[0];
    const tick = async (ms: number) => {
      await flush();
      await act(async () => mock.timers.tick(ms));
      await flush();
    };
    await mouse(row, 'mouseover');
    await tick(599);
    assert.equal(view.$('[data-popover]'), null);
    await tick(1);
    const card = () => view.$('.project-card');
    assert.equal(card().querySelector('.project-card-name')!.textContent, 'Proj');
    assert.equal(byText(card(), '.project-card-row', '1 task').textContent, '1 task');
    // Moving from the row into the card keeps it open.
    await mouse(row, 'mouseout', { relatedTarget: document.body });
    await mouse(card(), 'mouseover');
    await tick(150);
    assert.ok(card());
    await click(card().querySelector('.menu-pin')!);
    assert.deepEqual(getState().prefs.pinnedProjects, ['p1']);
    assert.match(card().querySelector('.menu-pin')!.className, /on/);
    await click(card().querySelector('.menu-pin')!);
    assert.deepEqual(getState().prefs.pinnedProjects, []);
    await click(byText(card(), 'button', '/work/p1'));
    assert.deepEqual(named('openPath'), [['/work/p1']]);
    await click(byText(card(), 'button', 'Edit project'));
    assert.equal(card(), null);
    assert.ok(view.$('.rename-input'));
    await key(view.$('.rename-input'), 'Escape');

    // Leaving hides it after a short delay; the popover's own close hides it at once.
    await mouse(row, 'mouseover');
    await tick(600);
    assert.ok(card());
    await mouse(card(), 'mouseout', { relatedTarget: document.body });
    await tick(150);
    assert.equal(card(), null);
    await mouse(row, 'mouseover');
    await tick(600);
    await click(view.$('[data-popover] [data-close]'));
    assert.equal(card(), null);

    // A folder group's card has no edit action and counts plural tasks.
    const folder = view.$$('.project-row')[2];
    await mouse(folder, 'mouseover');
    await tick(600);
    assert.equal(byText(card(), '.project-card-row', '2 tasks').textContent, '2 tasks');
    assert.equal(
      [...card().querySelectorAll('button')].some((b) => b.textContent === 'Edit project'),
      false,
    );
    await view.unmount();
  } finally {
    mock.timers.reset();
  }
});

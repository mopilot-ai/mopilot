// src/components/sidebar/ThreadRow.tsx and ChatLists.tsx: Recents, Cloud tasks, chat rows with their status, inline
// rename and context menu, and the thread menu.
import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import {
  calls,
  fx,
  reset,
  render,
  getState,
  update,
  click,
  key,
  mouse,
  pointer,
  blur,
  flush,
  thread,
  ThreadRow,
  named,
  mountSidebar,
  byText,
} from './support/shell-sidebar-kit.ts';

test('Recents lists chats, unfolds a project without showing all its chats when opening one of them, and shows more', async () => {
  const threads = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`r${i}`, thread(`r${i}`, { cwd: i === 0 ? '/work/folder' : '/home', updatedAt: 20 - i })]),
  );
  threads.old = thread('old', { cwd: '/work/folder', updatedAt: 1 });
  reset({ threadOrder: Object.keys(threads), threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  const view = await mountSidebar();
  const recents = () => byText(view.host, '.side-label', 'Recents').closest('.sidebar-section')!;
  const rows = () => [...recents().querySelectorAll('.thread-row')] as HTMLElement[];
  assert.equal(rows().length, 5);
  await click(byText(recents(), '.show-more', 'Show 5 more'));
  assert.equal(rows().length, 10);
  // three left: the last page takes them all
  await click(byText(recents(), '.show-more', 'Show 3 more'));
  assert.equal(rows().length, 13);
  await click(byText(recents(), '.show-more', 'Show less'));
  assert.equal(rows().length, 5);
  // An open chat with no project stretches Recents to reach it; one in a project shows there, so Recents stays folded.
  await update({ ...getState(), route: { name: 'thread', id: 'r10' } });
  await flush();
  assert.equal(rows().length, 11);
  await update({ ...getState(), route: { name: 'thread', id: 'old' } });
  await flush();
  assert.equal(rows().length, 5);
  const folder = byText(view.host, '.project-row .side-row-label', 'folder').closest('.project-group')!;
  assert.deepEqual(
    [...folder.querySelectorAll('.thread-row .side-row-label')].map((e) => e.textContent),
    ['Chat r0', 'Chat old'],
  );
  await update({ ...getState(), route: { name: 'home' } });
  await flush();
  calls.length = 0;
  await click(rows()[1]);
  assert.deepEqual(named('setState'), []);
  assert.deepEqual(getState().route, { name: 'thread', id: 'r1' });
  await click(rows()[0]);
  assert.deepEqual(named('setState'), [[{ collapsedProjects: { '/work/folder': false } }]]);
  assert.deepEqual(getState().revealedChats, {});
  await click(recents().querySelector('[aria-label="New chat"]')!);
  assert.deepEqual(getState().route, { name: 'home' });
  await click(byText(recents(), '.side-label', 'Recents'));
  assert.equal(rows().length, 0);
  await view.unmount();

  reset();
  const empty = await mountSidebar();
  assert.ok(byText(empty.host, '.empty-note', 'No chats'));
  await empty.unmount();
});

test('a chat row re-renders only when its own props change, so opening a chat re-renders the rows it selects', async () => {
  reset();
  const chat = thread('r0');
  const onOpen = () => {};
  let select!: (id: string) => void;
  function Rows() {
    const [selected, setSelected] = useState('other');
    select = setSelected;
    return h(ThreadRow, { thread: chat as any, active: selected === 'r0', indent: false, onOpen });
  }
  const view = await render(h(Rows));
  resetCommits();
  // another chat opened: the parent renders again, with the same props for this row
  await act(async () => select('another'));
  assert.deepEqual(rendersOf('ThreadRow'), []);
  await act(async () => select('r0'));
  assert.deepEqual(
    rendersOf('ThreadRow').map((p) => p.active),
    [true],
  );
  await view.unmount();
});

test('Cloud reveals running tasks and opens the selected task', async () => {
  const tasks = [
    { id: 't0', title: 'Fix bug', status: 'in_progress', environment_label: 'repo' },
    { id: 't1', status: 'done' },
    { id: 't2', title: 'Undefined status' },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, title: `Task ${i}`, status: 'QUEUED' })),
  ];
  reset({ cloudTasks: tasks, route: { name: 'cloud', id: 't1' } });
  const view = await mountSidebar();
  const section = byText(view.host, '.side-label', 'Cloud').closest('.sidebar-section')!;
  const rows = [...section.querySelectorAll('[data-sidebar-cloud]')] as HTMLElement[];
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.slice(0, 3).map((r) => r.querySelector('.side-row-label')!.textContent),
    ['Fix bug', 't1', 'Undefined status'],
  );
  assert.equal(rows[0].title, 'repo');
  assert.equal(rows[1].getAttribute('title'), null);
  assert.equal(rows[0].querySelector('.row-dot')!.className, 'row-dot working');
  assert.equal(rows[0].querySelector('.row-dot')!.getAttribute('aria-label'), 'Working');
  assert.equal(rows[1].querySelector('.row-dot'), null);
  assert.match(rows[1].className, /selected/);
  await click(rows[2]);
  assert.deepEqual(getState().route, { name: 'cloud', id: 't2' });
  await view.unmount();
});

test('chat rows show status in priority order and badges', async () => {
  reset({
    pending: [{ threadId: 'approve' }],
    runtime: { run: { activeTurnId: 'x' } },
    elsewhere: { away: { app: 'claude-desktop', running: true }, idle: { app: 'sage', running: false } },
    unread: { unread: true },
    worktreeOf: { wt: '/repo' },
    pinned: { 'pr-1': true },
    prefs: { showChatHarness: true },
  });
  const rows: Record<string, any> = {
    approve: thread('approve'),
    run: thread('run'),
    active: thread('active', { status: { type: 'active' } }),
    away: thread('away'),
    unread: thread('unread'),
    idle: thread('idle'),
    wt: thread('wt', { cwd: '/repo/wt', forkedFromId: 'x' }),
    'pr-1': thread('pr-1'),
  };
  const view = await render(
    h(
      'div',
      null,
      Object.values(rows).map((t) => h(ThreadRow, { key: t.id, thread: t, active: t.id === 'run' })),
    ),
  );
  const row = (id: string) => view.$$('.thread-row')[Object.keys(rows).indexOf(id)];
  // One 8px dot per state, as in Claude: waiting yellow, working pulsing gray, unread blue.
  assert.equal(row('approve').querySelector('.row-dot')!.className, 'row-dot waiting');
  assert.equal(row('approve').querySelector('.row-dot')!.getAttribute('aria-label'), 'Awaiting approval');
  assert.ok(row('run').querySelector('.row-dot.working'));
  assert.ok(row('run').querySelector('.shimmer-text'));
  assert.match(row('run').className, /indent selected/);
  assert.ok(row('active').querySelector('.row-dot.working'));
  assert.ok(row('active').querySelector('.shimmer-text'));
  assert.ok(row('away').querySelector('.row-dot.elsewhere'));
  assert.ok(row('away').querySelector('.shimmer-text'));
  for (const id of ['approve', 'run', 'active', 'away', 'unread']) assert.equal(row(id).querySelector('.spinner'), null, id);
  assert.ok(row('away').querySelector('[aria-label="Running in Claude desktop"]'));
  assert.equal(row('unread').querySelector('.row-dot')!.className, 'row-dot unread');
  assert.equal(row('idle').querySelector('.row-status [data-tooltip]')!.getAttribute('data-tooltip'), 'Open in another window');
  assert.deepEqual(
    [...row('wt').querySelectorAll('.thread-workspace svg')].map((s) => s.getAttribute('aria-label')),
    ['Forked conversation'],
  );
  assert.equal(row('pr-1').querySelector('.row-status')!.children.length, 0);
  assert.ok(row('pr-1').querySelector('[data-pr="pr-1"]'));
  assert.ok(row('approve').querySelector('[data-pr="approve"]'));
  assert.ok(row('approve').querySelector('[data-harness="approve"]'));
  assert.equal(row('pr-1').querySelector('[aria-label="More options"]')!.parentElement!.getAttribute('data-tooltip'), 'More options');

  // The hover menu's pin and archive commands act without opening the chat.
  calls.length = 0;
  const choose = async (id: string, label: string) => {
    await click(row(id).querySelector('[aria-label="More options"]')!);
    await click(byText(view.host, '[data-menu] [data-item]', label));
  };
  await choose('pr-1', 'Unpin');
  await choose('approve', 'Pin');
  assert.deepEqual(getState().pinned, { 'pr-1': false, approve: true });
  await choose('approve', 'Archive');
  fx.archiveError = new Error('locked');
  await choose('run', 'Archive');
  fx.archiveError = 'plain';
  await choose('run', 'Archive');
  await flush();
  assert.deepEqual(named('archive'), [['approve'], ['run'], ['run']]);
  assert.deepEqual(named('toast'), [
    ["Couldn't archive the chat: locked", 'error'],
    ["Couldn't archive the chat: plain", 'error'],
  ]);
  assert.deepEqual(named('navigate'), []);
  await view.unmount();
});

test('chat rows open, rename inline and offer matching context and ellipsis menus', async () => {
  reset({ pinned: { 'claude-1': true } });
  const opened: string[] = [];
  const t = thread('claude-1', { name: 'Original', cwd: '/work/c' });
  const view = await render(h(ThreadRow, { thread: t as any, active: false, indent: false, onOpen: () => opened.push('open') }));
  const row = () => view.$('.thread-row');
  assert.doesNotMatch(row().className, /indent/);
  await click(row());
  assert.deepEqual(opened, ['open']);
  assert.deepEqual(getState().route, { name: 'thread', id: 'claude-1' });

  // Double-click renames; clicks while editing don't navigate.
  await mouse(row(), 'dblclick');
  let input = view.$('.rename-input') as HTMLInputElement;
  assert.ok(input);
  await click(input);
  await click(row());
  assert.equal(opened.length, 1);
  input.value = ' Renamed ';
  await key(input, 'x');
  await key(input, 'Enter');
  await flush();
  assert.deepEqual(named('renameThread'), [['claude-1', 'Renamed']]);
  await mouse(row(), 'dblclick');
  input = view.$('.rename-input') as HTMLInputElement;
  input.value = 'Original';
  await blur(input);
  await mouse(row(), 'dblclick');
  (view.$('.rename-input') as HTMLInputElement).value = '';
  await blur(view.$('.rename-input'));
  await mouse(row(), 'dblclick');
  await key(view.$('.rename-input'), 'Escape');
  assert.equal(view.$('.rename-input'), null);
  assert.equal(named('renameThread').length, 1);
  for (const error of [new Error('taken'), 'nope']) {
    fx.renameError = error;
    await mouse(row(), 'dblclick');
    (view.$('.rename-input') as HTMLInputElement).value = 'Other';
    await blur(view.$('.rename-input'));
    await flush();
  }
  assert.deepEqual(named('toast'), [
    ['Rename failed: taken', 'error'],
    ['Rename failed: nope', 'error'],
  ]);

  // Right-click and ellipsis share the same concise menu.
  calls.length = 0;
  await mouse(row(), 'contextmenu', { clientX: 25, clientY: 30 });
  const menuLabels = () => [...view.host.querySelectorAll('[data-menu] [data-item]')].map((item) => item.textContent);
  const contextLabels = menuLabels();
  assert.ok(contextLabels.includes('Unpin'));
  assert.ok(contextLabels.includes('Mark as unread'));
  assert.ok(contextLabels.includes('Delete'));
  assert.ok(!contextLabels.includes('Copy chat ID'));
  await click(view.$('[data-close]'));
  await click(view.$('[aria-label="More options"]'));
  assert.deepEqual(menuLabels(), contextLabels);
  await click(view.$('[data-close]'));
  // ⌥-click opens it in split view, ⌘-click in a new window; neither navigates
  calls.length = 0;
  await mouse(row(), 'click', { altKey: true });
  await mouse(row(), 'click', { metaKey: true });
  assert.deepEqual(named('openInSplit'), [['claude-1']]);
  assert.deepEqual(named('winOpen'), [['thread=claude-1']]);
  assert.deepEqual(named('navigate'), []);
  await view.unmount();

  reset();
  const codex = await render(h(ThreadRow, { thread: thread('codex-1') as any, active: false }));
  await mouse(codex.$('.thread-row'), 'contextmenu');
  await click(byText(codex.host, 'button', 'Rename'));
  assert.ok(codex.$('.rename-input'));
  await key(codex.$('.rename-input'), 'Escape');
  await codex.unmount();
});

test('top-level and nested session rows retain PR badges while omitting worktree icons on every harness', async () => {
  for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
    for (const depth of [0, 1]) {
      reset({ worktreeOf: { [id]: '/repo' } });
      const chat = thread(id, { cwd: `/Users/dev/.mopilot/worktrees/${id}/repo` });
      const view = await render(h(ThreadRow, { thread: chat as any, active: true, depth }));
      try {
        assert.equal(view.$('.side-row-label').textContent, `Chat ${id}`);
        assert.equal(view.$('.thread-workspace'), null);
        assert.equal(view.$('[aria-label="Worktree"]'), null);
        assert.equal(view.$('[data-pr]').getAttribute('data-pr'), id);
        assert.equal(view.$('[data-pr]').getAttribute('data-pr-cwd'), chat.cwd);
      } finally {
        await view.unmount();
      }
    }
  }
});

test('a chat name the sidebar cuts short reads whole on hover, top-level or nested, and one that fits gets no title', async () => {
  reset();
  const LONG = 'Make a failing Sweep raise main-red like main runs';
  /** Gives `el` a box `client` wide holding content `scroll` wide (happy-dom has no layout). */
  const setOverflow = (el: Element, scroll: number, client: number) => {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: client });
  };
  for (const depth of [0, 1]) {
    const view = await render(h(ThreadRow, { thread: thread('r0', { name: LONG }) as any, active: false, depth }));
    const row = view.$('.thread-row');
    const label = view.$('.side-row-label');
    setOverflow(label, 420, 180);
    await pointer(label, 'pointerover');
    assert.equal(label.title, LONG);
    // the title sits on the label, so the row's pin and archive buttons show only their own tooltips
    assert.equal(row.hasAttribute('title'), false);
    // the sidebar widened and the name fits: the stale tooltip goes
    setOverflow(label, 180, 180);
    await pointer(label, 'pointerout');
    await pointer(label, 'pointerover');
    assert.equal(label.hasAttribute('title'), false);
    await view.unmount();
  }
  // renamed while the pointer rests on it: the tooltip follows the new name instead of keeping the old one
  const view = await render(h(ThreadRow, { thread: thread('r1', { name: LONG }) as any, active: false }));
  const rename = (name: string) =>
    act(async () => view.root.render(h(ThreadRow, { thread: thread('r1', { name }) as any, active: false })));
  const label = view.$('.side-row-label');
  setOverflow(label, 420, 180);
  await pointer(label, 'pointerover');
  assert.equal(label.title, LONG);
  await rename(`${LONG} again`);
  assert.equal(label.title, `${LONG} again`);
  // a name that changes while the label holds no tooltip isn't measured
  setOverflow(label, 180, 180);
  await pointer(label, 'pointerout');
  await pointer(label, 'pointerover');
  setOverflow(label, 420, 180);
  await rename('Short');
  assert.equal(label.hasAttribute('title'), false);
  await view.unmount();
});

test('a linked Cloud task follows its project, and the project plus opens its local checkout', async () => {
  reset({
    savedProjects: [{ id: 'p1', name: 'App project', roots: [{ path: '/work/app' }] }],
    cloudTasks: [{ id: 'task_known', title: 'Cloud change', environment_id: 'e', status: 'ready' }],
    cloudSidebar: { account: '[null,null]', environments: [{ id: 'e', label: 'Cloud app', repo: 'o/app' }] },
    route: { name: 'cloud', id: 'task_known' },
  });
  fx.repositories['/work/app'] = 'github.com/o/app';
  const view = await mountSidebar();
  const project = view.host.querySelector('.project-group')!;
  assert.equal(project.querySelector('[data-sidebar-cloud="task_known"]')?.textContent, 'Cloud changeCodex Cloud');
  assert.equal(view.host.querySelectorAll('[data-sidebar-cloud="task_known"]').length, 1);
  await click(project.querySelector('[aria-label="New chat in App project"]')!);
  assert.equal(getState().newChatProjectId, 'p1');
  assert.equal(getState().newChatCloudEnv, null);
  assert.equal(getState().newChatRepositoryGroup.destinations.length, 2);
  await view.unmount();
});

test('same-named cloud repositories keep their owner labels and toggle their own sessions', async () => {
  const fork = 'repo:github.com/42binwang/mopilot';
  const original = 'repo:github.com/mopilot-ai/mopilot';
  const tasks = [
    { id: 'task_fork', title: 'Fork task', status: 'pending', environment_id: 'fork' },
    { id: 'task_original', title: 'Original task', status: 'ready', environment_id: 'original' },
  ];
  const environments = [
    { id: 'fork', label: 'Fork environment', repo: '42binwang/mopilot' },
    { id: 'original', label: 'Original environment', repo: 'mopilot-ai/mopilot' },
  ];
  reset({
    cloudTasks: tasks,
    cloudSidebar: { account: '[null,null]', environments },
    collapsedProjects: { [fork]: true },
    route: { name: 'cloud', id: 'task_original' },
  });
  const view = await mountSidebar();
  try {
    const row = (owner: string) => byText(view.host, '.project-row .side-row-label', `mopilot · ${owner}`).closest('.project-row')!;
    for (const owner of ['42binwang', 'mopilot-ai']) {
      assert.equal(row(owner).getAttribute('aria-label'), `mopilot · ${owner}`);
      assert.equal(row(owner).querySelector('.side-row-label')?.getAttribute('title'), `mopilot · ${owner}`);
      assert.ok(row(owner).querySelector('.side-row-label + .host-mark[aria-label="Cloud"] .lucide-cloud'));
      assert.ok(row(owner).querySelector('.host-mark + .project-disclosure'));
    }
    assert.equal(row('42binwang').getAttribute('aria-expanded'), 'false');
    assert.equal(view.$('[data-sidebar-cloud="task_fork"]'), null);
    assert.ok(view.$('[data-sidebar-cloud="task_original"].selected'));

    await key(row('42binwang'), 'Enter');
    assert.equal(getState().collapsedProjects[fork], false);
    assert.equal(row('42binwang').getAttribute('aria-expanded'), 'true');
    assert.ok(view.$('[data-sidebar-cloud="task_fork"] .row-dot.working'));
    await mouse(row('mopilot-ai').querySelector('.project-disclosure')!, 'click');
    assert.equal(getState().collapsedProjects[original], true);
    assert.equal(view.$('[data-sidebar-cloud="task_original"]'), null);
    await click(view.$('[data-sidebar-cloud="task_fork"]'));
    assert.deepEqual(getState().route, { name: 'cloud', id: 'task_fork' });

    const alias = 'repo:github.com/42binwang/oss';
    await update({
      ...getState(),
      cloudTasks: [...tasks, { id: 'task_alias', title: 'Another task', environment_id: 'alias' }],
      cloudSidebar: {
        account: '[null,null]',
        environments: [...environments, { id: 'alias', label: 'Another env', repo: '42binwang/oss' }],
      },
      prefs: { ...getState().prefs, folderNames: { [alias]: 'mopilot' } },
    });
    const labels = view.$$('.project-row .side-row-label').map((element) => element.textContent);
    assert.equal(labels.length, 3);
    assert.equal(new Set(labels).size, 3, 'renaming another repository cannot duplicate the full label');
    await update({ ...getState(), cloudTasks: [], prefs: { ...getState().prefs, pinnedProjects: [fork] } });
    assert.ok(row('42binwang').querySelector('.host-mark .lucide-cloud'), 'a pinned cloud repository retains its location with no tasks');
  } finally {
    await view.unmount();
  }
});

test('a collapsed pinned repository keeps its row state as a local checkout joins it', async () => {
  const repository = 'github.com/o/app';
  const key = `repo:${repository}`;
  reset({
    cloudTasks: [{ id: 'task_known', title: 'Cloud change', environment_id: 'env' }],
    cloudSidebar: { account: '[null,null]', environments: [{ id: 'env', label: 'Cloud app', repo: 'o/app' }] },
    collapsedProjects: { [key]: true },
    prefs: { pinnedProjects: [key] },
  });
  const view = await mountSidebar();
  try {
    assert.equal(view.$('.project-row[aria-label="app · o"]')?.getAttribute('aria-expanded'), 'false');
    fx.repositories['/work/app'] = repository;
    await update({
      ...getState(),
      savedProjects: [{ id: 'local-app', name: 'Local app', roots: [{ path: '/work/app' }] }],
    });
    await flush();
    assert.deepEqual(
      view.$$('.project-row').map((row) => row.getAttribute('aria-label')),
      ['Local app'],
    );
    assert.equal(view.$('.project-row[aria-label="Local app"]')?.getAttribute('aria-expanded'), 'false');
  } finally {
    await view.unmount();
  }
});

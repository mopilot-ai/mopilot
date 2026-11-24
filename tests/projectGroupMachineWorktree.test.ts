// Remote Host worktrees share their repository's sidebar group while chat execution and folder preferences retain their owners.
import { beforeEach, test } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import { folderOf } from '../host/src/hostGit.mjs';
import { LOCAL_HOST_ID } from '../shared/host/localMachine.mjs';
import { mockSource } from './support/stubs.ts';

const HOST = { id: 'ssh:windows', name: 'LAPTOP-629FPHFM' };
const A = 'acp:host-codex:a';
const B = 'acp:host-claude:b';
const C = 'acp:kimi:c';
let owners = new Map<string, string>();
let machines = [HOST];
let answered = true;
const realChats = await import('../src/lib/hostChats.ts');
mockSource('src/lib/hostChats.ts', {
  ...realChats,
  useHostChats: () => ({ owners, status: 'ready', answered }),
  machineOfChat: (snapshot: { owners: Map<string, string>; answered: boolean }, id: string) =>
    snapshot.answered ? (snapshot.owners.get(id) ?? '') : null,
});
const realMachines = await import('../src/lib/hostMachines.ts');
mockSource('src/lib/hostMachines.ts', { ...realMachines, useHostMachines: () => ({ machines, resolved: true }) });
const kit = await import('./support/shell-sidebar-kit.ts');
const { reset, probe, thread, getState, mountSidebar, click, named, update, mouse, byText, flush, fx } = kit;
const { machineFolderKey: key } = await import('../src/lib/machineFolder.ts');
const { useChatStarts } = await import('../src/lib/chatStarts.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const repo = 'C:\\work\\project';
const worktree = (branch: string) => `${repo}.worktrees\\${folderOf(branch)}`;
const first = worktree('mopilot/5b40c0ba');
const second = worktree('team/3a201f8');

beforeEach(() => {
  machines = [HOST];
  owners = new Map([
    [A, HOST.id],
    [B, HOST.id],
    [C, HOST.id],
  ]);
  answered = true;
  useChatStarts.setState([], true);
  reset({
    threadOrder: [A, B, C],
    threads: { [A]: thread(A, { cwd: first }), [B]: thread(B, { cwd: second }), [C]: thread(C, { cwd: repo }) },
    prefs: { sidebarFolders: [key(HOST.id, first), key(HOST.id, second)] },
  });
});

test('machine names that match a combined hint still produce distinct project labels', async () => {
  const lookalike = { id: 'ssh:lookalike', name: `${HOST.name} · first` };
  machines = [HOST, lookalike];
  owners.set(C, lookalike.id);
  const paths = ['/first/project', '/second/project', repo];
  reset({ threadOrder: [A, B, C], threads: Object.fromEntries([A, B, C].map((id, i) => [id, thread(id, { cwd: paths[i] })])) });
  const view = await mountSidebar();
  try {
    const labels = view.$$('.project-row .side-row-label').map((row) => row.textContent);
    assert.equal(new Set(labels).size, 3);
    assert.ok(
      labels.some((label) => label?.includes(paths[0]) || label?.includes(repo)),
      'an exact path distinguishes the collision',
    );
  } finally {
    await view.unmount();
  }
});

test('a project renamed to another project’s full label cannot make their sidebar rows identical', async () => {
  machines = [HOST, { id: 'ssh:box', name: 'Box' }, { id: 'ssh:lab', name: 'Lab' }];
  owners.set(B, 'ssh:box');
  owners.set(C, 'ssh:lab');
  reset({
    threadOrder: [A, B, C],
    threads: Object.fromEntries([A, B, C].map((id) => [id, thread(id, { cwd: repo })])),
    prefs: { folderNames: { [key('ssh:lab', repo)]: `project · ${HOST.name}` } },
  });
  const view = await mountSidebar();
  try {
    const labels = view.$$('.project-row .side-row-label').map((row) => row.textContent);
    assert.equal(new Set(labels).size, 3);
    assert.ok(labels.some((label) => label?.includes(repo)));
  } finally {
    await view.unmount();
  }
});

for (const [scenario, firstName, secondName, hint] of [
  ['canonical Unicode equivalents share a comparison key', 'caf\u00e9', 'cafe\u0301', true],
  ['zero-width spaces share a comparison key', 'app', 'ap\u200bp', true],
  ['emoji joiners preserve distinct comparison keys', '👩\u200d💻', '👩💻', false],
] as const) {
  test(scenario, async () => {
    machines = [HOST, { id: 'ssh:box', name: 'Box' }];
    owners.set(B, 'ssh:box');
    reset({
      threadOrder: [A, B],
      threads: { [A]: thread(A, { cwd: `/srv/${firstName}` }), [B]: thread(B, { cwd: `/srv/${secondName}` }) },
    });
    const view = await mountSidebar();
    try {
      const labels = view.$$('.project-row .side-row-label').map((row) => row.textContent);
      const expected = hint ? [`${firstName} · ${HOST.name}`, `${secondName} · Box`] : [firstName, secondName];
      assert.deepEqual(labels.sort(), expected.sort());
    } finally {
      await view.unmount();
    }
  });
}

test('same paths with indistinguishable machine display names still show distinct project labels', async () => {
  const name = 'ssh:removed';
  machines = [
    { ...HOST, name },
    { id: 'ssh:renamed', name },
  ];
  owners.set(B, name);
  owners.set(C, 'ssh:renamed');
  reset({ threadOrder: [A, B, C], threads: Object.fromEntries([A, B, C].map((id) => [id, thread(id, { cwd: '/project' })])) });
  const view = await mountSidebar();
  try {
    const labels = view
      .$$('.project-row .side-row-label')
      .map((row) => row.textContent)
      .sort();
    assert.deepEqual(labels, ['project', 'project · /project', 'project · /project (2)']);
  } finally {
    await view.unmount();
  }
});

test('the screenshot folders become one repository group across remote Codex, Claude and basic ACP, preserving each cwd', async () => {
  const asked: string[] = [];
  kit.fx.canonicalPaths = async (paths) => (asked.push(...paths), Object.fromEntries(paths.map((p) => [p, p])));
  const { get, view } = await probe();
  try {
    const groups = get().listed;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'project');
    assert.equal(groups[0].path, repo);
    assert.equal(groups[0].machine.id, HOST.id);
    assert.deepEqual(
      groups[0].threads.map((t: any) => t.cwd),
      [first, second, repo],
    );
    assert.equal(
      asked.some((p) => [repo, first, second].includes(p) || p.includes('\0')),
      false,
    );
    assert.deepEqual(getState().prefs.sidebarFolders, [key(HOST.id, first), key(HOST.id, second)]);
  } finally {
    await view.unmount();
  }
});

test('nested sessions share the project icon only while their Host matches the rest of the project', async () => {
  markWindowReady();
  resetSideSessions();
  fx.orchestration = { children: { [B]: { parentId: A, createdAt: 1 } }, deliveries: {}, proposals: {}, queue: [] };
  const view = await mountSidebar();
  try {
    await flush();
    const row = (id: string) => view.$(`.project-group [data-sidebar-chat="${id}"]`);
    const mark = (id: string) => row(id).querySelector('.host-mark');
    const projectMark = () => view.$('.project-row .host-mark');
    assert.ok(row(B).matches('.linked-child'));
    assert.equal(projectMark()?.getAttribute('title'), `On ${HOST.name}`);
    assert.equal(mark(A), null);
    assert.equal(mark(B), null);
    assert.equal(mark(C), null);
    assert.match(row(B).querySelector('.sr-only')?.textContent ?? '', /On LAPTOP-629FPHFM/);

    await click(row(A).querySelector('.nested-caret')!);
    assert.equal(row(B), null);
    owners = new Map(owners).set(B, 'another-host');
    await update({ ...getState(), threads: { ...getState().threads } });
    assert.equal(row(B), null);
    assert.deepEqual(
      view.$$('.project-row .host-mark').map((mark) => mark.getAttribute('title')),
      ['Remote machine', 'SSH'],
    );
    assert.equal(mark(A)?.getAttribute('title'), `On ${HOST.name}`);
    await click(row(A).querySelector('.nested-caret')!);
    assert.equal(mark(B)?.getAttribute('title'), 'On another-host');
    owners = new Map(owners).set(B, 'ssh:another-host');
    await update({ ...getState(), threads: { ...getState().threads } });
    assert.equal(projectMark()?.getAttribute('title'), 'SSH');
    assert.equal(mark(B)?.getAttribute('title'), 'On ssh:another-host');
  } finally {
    await view.unmount();
    resetSideSessions();
  }
});

test('the same repository on another machine or this Mac stays separate; unknown owners wait in Recents', async () => {
  owners.set(B, 'other');
  owners.delete(C);
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().listed.map((g: any) => [g.machine?.id, g.path]),
      [
        [HOST.id, repo],
        ['other', repo],
        [undefined, repo],
      ],
    );
    answered = false;
    await update({ ...getState() });
    assert.equal(get().groups.flatMap((g: any) => g.threads).length, 0);
    assert.deepEqual(
      get().recents.map((t: any) => t.id),
      [A, B, C],
    );
  } finally {
    await view.unmount();
  }
});

test('a shared SSH icon replaces session icons in Projects while Recents and Priority keep them', async () => {
  answered = false;
  const view = await mountSidebar();
  try {
    assert.equal(view.$('.thread-row .host-mark'), null);
    answered = true;
    await update({ ...getState() });
    assert.equal(view.$('.project-row .side-row-label').textContent, 'project');
    assert.ok(view.$('.project-row .side-row-label + .host-mark .lucide-square-terminal'));
    for (const id of [A, B, C]) {
      const rows = view.$$(`[data-sidebar-chat="${id}"]`);
      assert.equal(rows.length, 2, 'each chat shows in Projects and Recents');
      for (const row of rows) {
        assert.equal(!!row.querySelector(`.host-mark[title="On ${HOST.name}"] .lucide-square-terminal`), !row.closest('.project-group'));
        assert.doesNotMatch(row.querySelector('.side-row-name')!.textContent!, /LAPTOP/);
        assert.equal(row.querySelector('.side-row-sub'), null);
      }
    }
    await act(async () =>
      useChatStarts.setState(
        [
          { id: 'starting', name: 'Starting', cwd: repo, projectId: null, hostId: HOST.id, updatedAt: 1 },
          { id: 'removed', name: 'Other start', cwd: '', projectId: null, hostId: 'other', updatedAt: 1 },
        ],
        true,
      ),
    );
    for (const row of view.$$('[data-chat-start="starting"]')) {
      assert.equal(!!row.querySelector(`.host-mark[title="On ${HOST.name}"] .lucide-square-terminal`), !row.closest('.project-group'));
      assert.equal(row.getAttribute('aria-description'), `On ${HOST.name}`);
      assert.ok(row.querySelector('.row-dot.working'));
    }
    assert.equal(view.$$('[data-chat-start="starting"]').length, 2);
    assert.ok(view.$('[data-chat-start="removed"] .host-mark[title="On other"] .lucide-monitor'));

    await update({ ...getState(), activityView: true, unread: { [B]: true } });
    assert.ok(view.$(`.priority-card[data-sidebar-chat="${B}"] .host-mark .lucide-square-terminal`));
  } finally {
    await view.unmount();
  }
});

test('the background Host uses one project laptop and keeps per-session activity visible', async () => {
  machines = [{ id: LOCAL_HOST_ID, name: 'This Mac' }];
  owners = new Map([A, B, C].map((id) => [id, LOCAL_HOST_ID]));
  await update({ ...getState(), pending: [{ threadId: B }] });
  const view = await mountSidebar();
  try {
    assert.equal(view.$$('.project-row .lucide-laptop').length, 1);
    assert.equal(view.$$('.project-group .thread-row .host-mark').length, 0);
    const waiting = view.$$(`[data-sidebar-chat="${B}"] .row-dot.waiting`);
    assert.equal(waiting.length, 2);
    assert.ok(view.$(`[data-shortcut-recents] [data-sidebar-chat="${B}"] .lucide-laptop`));
  } finally {
    await view.unmount();
  }
});

test('same-named projects disambiguate within their icon groups by machine and parent folder', async () => {
  const paths = ['C:\\team\\first\\project', 'C:\\team\\second\\project', repo];
  reset({
    threadOrder: [A, B, C, 'local1', 'local2'],
    threads: {
      ...Object.fromEntries([A, B, C].map((id, i) => [id, thread(id, { cwd: paths[i] })])),
      local1: thread('local1', { cwd: '/one/project' }),
      local2: thread('local2', { cwd: '/two/project' }),
    },
  });
  const view = await mountSidebar();
  const hints = () =>
    view
      .$$('.project-hint')
      .map((hint) => hint.textContent)
      .sort();
  try {
    assert.deepEqual(hints(), [' · first', ' · one', ' · second', ' · two', ' · work']);
    assert.equal(view.$$('.project-row .lucide-square-terminal').length, 3);
    assert.ok(view.$(`.project-row[aria-label="project · first"][aria-description="On ${HOST.name}"]`));
    owners = new Map(owners).set(C, 'ssh:other');
    await update({ ...getState() });
    assert.deepEqual(hints(), [' · LAPTOP-629FPHFM · first', ' · LAPTOP-629FPHFM · second', ' · one', ' · ssh:other', ' · two']);
    assert.equal(view.$('.project-row[aria-description="On ssh:other"] .project-hint').textContent, ' · ssh:other');

    owners = new Map(owners).set(C, 'this-mac-host');
    await update({ ...getState() });
    assert.deepEqual(hints(), [' · first', ' · one', ' · second', ' · two']);
    assert.ok(view.$('.project-row .lucide-laptop'));
  } finally {
    await view.unmount();
  }
});

test('saved worktree pins, names and manual order apply to the repository, and unpin removes every old alias', async () => {
  const alias = key(HOST.id, first);
  const otherAlias = key(HOST.id, second);
  const canonical = key(HOST.id, repo);
  await update({
    ...getState(),
    prefs: {
      ...getState().prefs,
      pinnedProjects: [alias, otherAlias],
      folderNames: { [alias]: 'My project' },
      projectSort: 'manual',
      sidebarProjectOrder: [alias, otherAlias],
      chatSort: 'manual',
      chatOrder: { [alias]: [B, A], [otherAlias]: [C] },
    },
  });
  const { get, view } = await probe();
  try {
    const g = get().listed[0];
    assert.equal(g.name, 'My project');
    assert.deepEqual(g.pinnedKeys, [alias, otherAlias]);
    assert.deepEqual(
      g.threads.map((t: any) => t.id),
      [B, A, C],
    );
    assert.deepEqual(getState().prefs.sidebarProjectOrder, [alias, otherAlias]);
    await update({ ...getState(), prefs: { ...getState().prefs, folderNames: { [alias]: 'Old', [canonical]: 'Repository' } } });
    assert.equal(get().listed[0].name, 'Repository');
  } finally {
    await view.unmount();
  }
  const sidebar = await mountSidebar();
  try {
    await mouse(sidebar.$('.project-row'), 'contextmenu');
    await click(byText(sidebar.$('[data-menu]'), 'button', 'Unpin'));
    assert.deepEqual(getState().prefs.pinnedProjects, []);
  } finally {
    await sidebar.unmount();
  }
});

test('a picked or starting worktree selects its repository; New chat uses that repository on the same machine', async () => {
  await update({ ...getState(), newChatHost: { ...HOST, path: first }, newChatProjectId: null, newChatCwd: null });
  useChatStarts.setState(
    [{ id: 'start', name: 'Starting', cwd: `${second}\\packages\\web`, projectId: null, hostId: HOST.id, updatedAt: 1 }],
    true,
  );
  const { get, view } = await probe();
  try {
    assert.equal(get().homeKey, key(HOST.id, repo));
    assert.equal(get().listed.length, 1);
    assert.equal(get().listed[0].starting.length, 1);
  } finally {
    await view.unmount();
    useChatStarts.setState([], true);
  }
  const sidebar = await mountSidebar();
  try {
    assert.ok(sidebar.$('.project-row').classList.contains('selected'));
    await click(sidebar.$('[aria-label="New chat in project"]'));
    assert.deepEqual(named('setNewChatHostFolder'), [[HOST, repo]]);
    assert.equal(getState().threads[A].cwd, first);
  } finally {
    await sidebar.unmount();
  }
});

test('hiding an old worktree keeps its chats in Recents; hiding the repository hides all its worktrees', async () => {
  await update({ ...getState(), prefs: { ...getState().prefs, hiddenFolders: [key(HOST.id, first)] } });
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().listed.flatMap((g: any) => g.threads.map((t: any) => t.id)),
      [B, C],
    );
    await update({ ...getState(), prefs: { ...getState().prefs, hiddenFolders: [key(HOST.id, repo)] } });
    assert.deepEqual(get().listed, []);
    assert.deepEqual(
      get().recents.map((t: any) => t.id),
      [A, B, C],
    );
  } finally {
    await view.unmount();
  }
});

test('saved worktree collapse follows the repository, while a new explicit expand survives a remount', async () => {
  const alias = key(HOST.id, first);
  const canonical = key(HOST.id, repo);
  await update({ ...getState(), collapsedProjects: { [alias]: true } });
  const sidebar = await mountSidebar();
  try {
    assert.equal(sidebar.$('.project-row').getAttribute('aria-expanded'), 'false');
    await click(sidebar.$('.project-row'));
    assert.equal(getState().collapsedProjects[canonical], false);
    assert.equal(getState().collapsedProjects[alias], true, 'the saved alias is retained');
  } finally {
    await sidebar.unmount();
  }
  const restored = await mountSidebar();
  try {
    assert.equal(restored.$('.project-row').getAttribute('aria-expanded'), 'true');
  } finally {
    await restored.unmount();
  }
});

test('a hidden pinned worktree never resurrects an empty repository row or pins a visible sibling', async () => {
  const alias = key(HOST.id, first);
  await update({
    ...getState(),
    threadOrder: [A],
    threads: { [A]: getState().threads[A] },
    prefs: { sidebarFolders: [alias], pinnedProjects: [alias], hiddenFolders: [alias] },
  });
  const { get, view } = await probe();
  try {
    assert.deepEqual(get().listed, []);
    await update({ ...getState(), threads: { ...getState().threads, [B]: thread(B, { cwd: second }) }, threadOrder: [A, B] });
    assert.equal(get().listed.length, 1);
    assert.deepEqual(get().listed[0].pinnedKeys, []);
    await update({
      ...getState(),
      threadOrder: [A],
      threads: { [A]: getState().threads[A] },
      newChatProjectId: null,
      newChatCwd: null,
      newChatHost: { ...HOST, path: first },
    });
    assert.deepEqual(get().listed, []);
    assert.equal(get().homeKey, null);
  } finally {
    await view.unmount();
  }
});

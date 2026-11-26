// A mixed sidebar project keeps remote checkouts, row order and composer destinations owned by their machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { noteHostChat } from '../src/lib/hostChats.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { native } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';
import { byText, click, flush, fx, getState, mountSidebar, named, project, reset, thread, update } from './support/shell-sidebar-kit.ts';

test('a remote session and Codex Cloud task join a local project and use its surviving destination choices', async (t) => {
  const chatId = 'acp:kimi:remote';
  const local = '/home/local/checkout';
  const remote = '/srv/remote/checkout';
  const remoteSource = `${remote}/src`;
  const repo = 'github.com/org/app';
  const hostChats = [chatId, 'acp:host-codex:remote', 'acp:host-claude:remote'];
  const cloud = { id: 'task_cloud', title: 'Cloud change', status: 'ready', environment_id: 'env', updated_at: 100 };
  reset({
    savedProjects: [project('local', local, 'Shared project')],
    threadOrder: hostChats,
    threads: Object.fromEntries(
      hostChats.map((id, index) => [id, thread(id, { cwd: index === 1 ? remoteSource : remote, updatedAt: 10 - index })]),
    ),
    cloudTasks: [cloud],
    cloudSidebar: { account: '[null,null]', environments: [{ id: 'env', label: 'Cloud app', repo: 'org/app' }] },
    route: { name: 'cloud', id: cloud.id },
    prefs: { chatSort: 'manual' },
  });
  fx.repositories[local] = repo;
  const machineId = 'ssh:box';
  const ssh = { id: machineId, name: 'Build box', note: '', repositoryScope: 'paired', status: 'online' };
  const cloudHost = { provider: 'oci', id: 'vm1', region: 'us', size: 'small', network: 'full' };
  let machine: typeof ssh & { cloud?: typeof cloudHost } = ssh;
  let updateMachines: (rows: unknown) => void = () => undefined;
  const list = () => ({ machines: [machine], resolved: true });
  const previous = native.host;
  native.host = fakeNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      machines: async () => list(),
      onMachines: (callback: typeof updateMachines) => {
        updateMachines = callback;
        return () => undefined;
      },
      remoteChats: async () => hostChats.map((id) => ({ chatId: id, hostId: machineId })),
      sidebarRepository: async (_id: string, query: { path: string; checkout?: true }) => ({
        value: query.checkout ? remote : query.path === remote ? repo : null,
      }),
    },
  }).host;
  t.after(() => {
    native.host = previous;
  });

  const view = await mountSidebar();
  try {
    await flush();
    const group = () => view.$('.project-row[aria-label="Shared project"]')!.closest('.project-group')!;
    assert.ok(group().querySelector('[data-sidebar-cloud="task_cloud"]'));
    assert.ok(group().textContent?.includes(`Chat ${chatId}`));
    const marks = () => [...group().querySelectorAll('.project-row .host-mark')].map((mark) => mark.getAttribute('aria-label'));
    assert.deepEqual(marks(), ['Cloud', 'SSH']);
    const terminal = group().querySelector('.project-row .lucide-square-terminal');
    assert.ok(terminal?.parentElement?.nextElementSibling?.classList.contains('project-disclosure'));
    const chat = () => group().querySelector(`[data-sidebar-chat="${chatId}"]`)!;
    assert.ok(chat().querySelector('.host-mark .lucide-square-terminal'));
    assert.equal(view.$$('.project-row').length, 1);
    assert.ok(named('folderAvailability').every(([paths]) => !paths.includes(remote)));

    machine = { ...ssh, cloud: cloudHost };
    await act(async () => updateMachines(list()));
    assert.deepEqual(marks(), ['Cloud'], 'the cloud machine and Codex Cloud share one marker');
    assert.ok(chat().querySelector('.host-mark .lucide-cloud'));
    machine = ssh;
    await act(async () => updateMachines(list()));
    assert.deepEqual(marks(), ['Cloud', 'SSH']);

    const background = { ...ssh, id: 'this-mac-host', name: 'This Mac · keeps running' };
    await act(async () => {
      updateMachines({ machines: [ssh, background], resolved: true });
      for (const id of hostChats) noteHostChat(id, background.id);
    });
    await flush();
    assert.deepEqual(marks(), ['Background Host', 'Cloud']);
    assert.ok(chat().querySelector('.host-mark[title="On This Mac · keeps running"] .lucide-laptop'));

    const relay = { ...ssh, id: 'relay:another', name: 'Relay machine' };
    await act(async () => {
      updateMachines({ machines: [ssh, background, relay], resolved: true });
      noteHostChat(chatId, machineId);
      noteHostChat(hostChats[2], relay.id);
    });
    await flush();
    assert.deepEqual(marks(), ['Background Host. Cloud. Remote machine. SSH']);
    assert.ok(group().querySelector('.project-row .lucide-layers'));
    await act(async () => {
      for (const id of hostChats) noteHostChat(id, machineId);
      updateMachines(list());
    });
    await flush();

    const snapshot = getState();
    const savedFolder = machineFolderKey(machineId, remote);
    await update({
      ...snapshot,
      threads: {},
      threadOrder: [],
      cloudTasks: [],
      prefs: { ...snapshot.prefs, sidebarFolders: [savedFolder], pinnedProjects: [savedFolder] },
    });
    await flush();
    assert.deepEqual(marks(), ['Cloud', 'SSH'], 'the empty pinned project shows its available destinations');
    await update({ ...getState(), cloudTasks: [cloud] });
    assert.deepEqual(marks(), ['Cloud'], 'a Cloud-only group describes its task without showing the empty SSH destination');

    await update({ ...snapshot, cloudTasks: undefined });
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 0);
    const sessionMarks = () => group().querySelectorAll('.thread-row .host-mark');
    assert.deepEqual(marks(), ['On Build box'], 'all three remote harnesses share the project row’s Host icon');
    assert.equal(sessionMarks().length, 0);
    const recents = byText(view.host, '.side-label', 'Recents').closest('.sidebar-section');
    assert.equal(recents?.querySelector(`[data-sidebar-chat="${chatId}"] .host-mark`)?.getAttribute('title'), 'On Build box');

    const localId = 'local-chat';
    await update({
      ...getState(),
      threadOrder: [...snapshot.threadOrder, localId],
      threads: { ...snapshot.threads, [localId]: thread(localId, { cwd: local }) },
    });
    assert.equal(sessionMarks().length, 3, 'a local session restores the remote chats’ individual icons');
    assert.deepEqual(marks(), [], 'a project with a local session does not read as an SSH project');
    await update({ ...getState(), cloudTasks: [cloud] });
    assert.deepEqual(marks(), [], 'nor as a Cloud project once a Cloud task joins it');
    assert.ok(group().querySelector('[data-sidebar-cloud="task_cloud"] .host-mark .lucide-cloud'), 'the task keeps its own icon');
    assert.equal(sessionMarks().length, 4);
    await update({ ...snapshot, accounts: { active: 'another' } });
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 0);
    await update({ ...snapshot, prefs: { ...snapshot.prefs, sidebarOrganize: 'list' } });
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 1);
    await update({ ...getState(), prefs: { ...getState().prefs, chatSort: 'updated', sidebarOrganize: 'list' } });
    await flush();
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 1);
    await update({ ...getState(), route: { name: 'home' } });
    await flush();
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 1);

    fx.exists = false;
    const missing = '/home/local/unavailable';
    fx.repositories[missing] = repo;
    await update({ ...getState(), savedProjects: [project('local', missing, 'Shared project')] });
    await flush();
    await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'project' } });
    assert.ok(group().querySelector('[data-sidebar-cloud="task_cloud"]'));

    await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'project' }, savedProjects: [] });
    await flush();
    const newChat = () => view.$('.project-group [aria-label="New chat in app"]')!;
    await click(newChat());
    assert.equal(getState().newChatRepositoryGroup.needsLocation, true);
    machine = { ...machine, status: 'offline' };
    await act(async () => updateMachines(list()));
    await click(newChat());
    assert.equal(getState().newChatCloudEnv.id, 'env');
    assert.equal(getState().newChatHost, null);

    const confirm = globalThis.confirm;
    globalThis.confirm = () => true;
    t.after(() => {
      globalThis.confirm = confirm;
    });
    const repository = view.$('.project-row[aria-label="app · org"]')!.closest('.project-group')!;
    await click(repository.querySelector('[data-tooltip="Project actions"] button')!);
    await click(byText(view.$('[data-menu]'), 'button', 'Remove from sidebar'));
    assert.deepEqual(getState().prefs.hiddenFolders, [
      'repo:github.com/org/app',
      machineFolderKey(machineId, remote),
      machineFolderKey(machineId, remoteSource),
    ]);
    await flush();
    assert.equal(view.$$('.project-row').length, 0);
    assert.equal(view.$$('.thread-row[data-sidebar-cloud="task_cloud"]').length, 1);
  } finally {
    await view.unmount();
  }
});

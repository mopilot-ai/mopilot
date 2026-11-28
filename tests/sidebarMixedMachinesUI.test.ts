// Sessions on a machine keep that machine folder's own sidebar group, apart from a local project of the same repository, as in Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { native } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';
import { byText, click, flush, fx, getState, mountSidebar, named, project, reset, thread } from './support/shell-sidebar-kit.ts';

test('remote sessions keep their machine folder group while a Codex Cloud task joins the local project', async (t) => {
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
  const repositoryQueries: string[] = [];
  const previous = native.host;
  native.host = fakeNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      machines: async () => ({ machines: [ssh], resolved: true }),
      onMachines: () => () => undefined,
      remoteChats: async () => hostChats.map((id) => ({ chatId: id, hostId: machineId })),
      sidebarRepository: async (_id: string, query: { path: string; checkout?: true }) => {
        if (!query.checkout) repositoryQueries.push(query.path);
        return { value: query.checkout ? remote : query.path === remote ? repo : null };
      },
    },
  }).host;
  t.after(() => {
    native.host = previous;
  });

  const view = await mountSidebar();
  try {
    await flush();
    const shared = () => view.$('.project-row[aria-label="Shared project"]')!.closest('.project-group')!;
    const onMachine = () => view.$(`[data-sidebar-chat="${chatId}"]`)!.closest('.project-group')!;
    const marks = (group: Element) => [...group.querySelectorAll('.project-row .host-mark')].map((mark) => mark.getAttribute('aria-label'));
    assert.equal(view.$$('.project-row').length, 2);
    assert.notEqual(onMachine(), shared());
    assert.ok(shared().querySelector('[data-sidebar-cloud="task_cloud"]'), 'the Cloud task joins the local project of its repository');
    assert.equal(shared().querySelectorAll('[data-sidebar-chat]').length, 0, 'no session on the machine joins the local project');
    assert.deepEqual(
      hostChats.map((id) => !!onMachine().querySelector(`[data-sidebar-chat="${id}"]`)),
      [true, true, true],
      'every harness on the checkout, including its subfolder, shares the machine folder group',
    );
    assert.equal(onMachine().querySelector('[data-sidebar-cloud]'), null);
    assert.ok(onMachine().querySelector('.project-row .lucide-square-terminal'), 'the machine group names its SSH location once');
    assert.equal(onMachine().querySelectorAll('.thread-row .host-mark').length, 0);
    assert.deepEqual(marks(shared()), ['Cloud']);
    assert.ok(named('folderAvailability').every(([paths]) => !paths.includes(remote)));
    assert.deepEqual(repositoryQueries, [], 'machine folders are not asked for a repository, since none joins a local project');

    const confirm = globalThis.confirm;
    globalThis.confirm = () => true;
    t.after(() => {
      globalThis.confirm = confirm;
    });
    await click(onMachine().querySelector('[data-tooltip="Project actions"] button')!);
    await click(byText(view.$('[data-menu]'), 'button', 'Remove from sidebar'));
    const hidden = getState().prefs.hiddenFolders;
    assert.ok(hidden.includes(machineFolderKey(machineId, remote)));
    assert.ok(!hidden.includes('repo:github.com/org/app'), 'removing the machine folder leaves the repository and its local project');
    await flush();
    assert.equal(view.$$('.project-row').length, 1);
    assert.ok(shared().querySelector('[data-sidebar-cloud="task_cloud"]'));
  } finally {
    await view.unmount();
  }
});

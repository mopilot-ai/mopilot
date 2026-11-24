// Repository sidebar matching, fallback and source identity across local, machine and Cloud sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarRepository, cloudRepository } from '../shared/sidebarRepository.mjs';
import { groupRepositories } from '../src/components/sidebar/repositoryGroups.ts';
import { labelProjects } from '../src/components/sidebar/projectLabels.ts';
import { mergeProjectRows, projectRows, sortProjectRows } from '../src/components/sidebar/projectRows.ts';
import { parseMachineList } from '../src/lib/hostMachines.ts';
import { cloudActivity, groupKey, projectRecency, sortProjectGroups } from '../src/lib/projectGroupOrder.ts';
import type { ProjectGroupData } from '../src/components/sidebar/projectGroups.ts';
import type { Thread } from '../src/store/types.ts';

const repo = 'github.com/org/app';
const chat = (id: string, updatedAt: number) => ({ id, updatedAt }) as Thread;
const local: ProjectGroupData = { id: 'saved-app', path: '/local/app', name: 'My app', threads: [chat('local', 1)], saved: true };
const box: ProjectGroupData = {
  id: null,
  path: '/different/checkout',
  name: 'checkout',
  machine: { id: 'box', name: 'Build box' },
  threads: [chat('machine', 2)],
  saved: false,
};
const other = { ...local, id: 'other', path: '/local/other' };
const task = { id: 'task_a', environment_id: 'env', updated_at: '2026-01-01T00:00:00Z', status: 'ready' };
const env = { id: 'env', label: 'Build environment', repo: 'Org/App', repositories: ['Org/App'], pinned: false };

test('same-named projects using the mixed glyph keep distinct folder hints', () => {
  const machines = parseMachineList({
    machines: [{ id: 'relay:vm', name: 'Cloud VM', note: '', status: 'online', cloud: { id: 'vm', provider: 'oci' } }],
  })!.machines;
  const owners = new Map<string, string>();
  const groups: ProjectGroupData[] = [
    ['ssh:box', 'relay:far', 'this-mac-host'],
    ['ssh:box', 'relay:far', 'relay:vm'],
  ].map((hosts, index) => ({
    ...local,
    id: `project-${index}`,
    name: 'app',
    path: `/work/team-${index}/app`,
    threads: hosts.map((host, position) => {
      const id = `chat-${index}-${position}`;
      owners.set(id, host);
      return chat(id, position);
    }),
  }));
  labelProjects(groups, machines, (id) => owners.get(id) ?? '', new Map([...owners.keys()].map((id) => [id, []])));
  assert.deepEqual(
    groups.map(({ hint }) => hint),
    ['team-0', 'team-1'],
  );
});

test('GitHub aliases share an identity while forks and other Git servers remain distinct', () => {
  for (const origin of ['git@github.com:Org/App.git', 'ssh://git@github.com/org/app', 'https://user:token@github.com/org/app.git'])
    assert.equal(sidebarRepository(origin), repo);
  assert.equal(cloudRepository('ORG/App'), repo);
  assert.notEqual(sidebarRepository('https://github.com/another/app'), repo);
  assert.notEqual(sidebarRepository('https://github.com:444/org/app'), repo);
  assert.equal(sidebarRepository('file:///repo'), null);
  assert.equal(sidebarRepository('git@github.com:org/../app'), null);
  assert.equal(cloudRepository('unqualified'), null);
});

test('verified machine and cloud rows join the local group without changing session identities', () => {
  const declared = [local, box];
  const result = groupRepositories(declared, new Set(declared.map(groupKey)), () => repo, [task], [env], [], groupKey(box));
  assert.deepEqual(result.cloud, []);
  assert.deepEqual(result.listed.map(groupKey), ['saved-app']);
  assert.equal(result.homeKey, 'saved-app');
  assert.deepEqual(
    result.listed[0].threads.map((thread) => thread.id),
    ['local', 'machine'],
  );
  assert.deepEqual(
    result.listed[0].locations?.map((location) => location.kind),
    ['machine', 'cloud'],
  );
  assert.deepEqual(
    local.threads.map((thread) => thread.id),
    ['local'],
  );
  const mixed = projectRows(result.listed[0].threads, result.listed[0].cloudTasks);
  assert.deepEqual(
    sortProjectRows(mixed).map((row) => row.key),
    ['cloud:task_a', 'machine', 'local'],
  );
  assert.deepEqual(
    sortProjectRows(mixed, ['local', 'machine', 'cloud:task_a']).map((row) => row.key),
    ['local', 'machine', 'cloud:task_a'],
  );
  assert.equal(projectRecency(result.listed[0]), Date.parse(task.updated_at) / 1000);
});

test('distinct saved local copies stay separate and unknown or multi-repository cloud tasks stay in Cloud', () => {
  const declared = [local, other, box];
  const unmatched = { ...task, id: 'task_b', environment_id: 'multi' };
  const legacy = { id: 'task_c', environment_label: env.label };
  const result = groupRepositories(
    declared,
    new Set(declared.map(groupKey)),
    () => repo,
    [task, unmatched, legacy],
    [env, { ...env, id: 'multi', repositories: ['Org/App', 'Org/Other'] }],
    [],
    null,
  );
  assert.deepEqual(result.listed.map(groupKey), ['saved-app', 'other', 'repo:github.com/org/app']);
  assert.deepEqual(
    result.listed[2].threads.map((thread) => thread.id),
    ['machine'],
  );
  assert.deepEqual(result.listed[2].cloudTasks, [task]);
  assert.deepEqual(result.cloud, [unmatched, legacy]);
});

test('a machine with unknown repository keeps its folder group and a hidden saved project is skipped', () => {
  const declared = [local, box];
  const listed = new Set(declared.map(groupKey));
  const result = groupRepositories(declared, listed, (group) => (group.machine ? undefined : repo), [task], [env], [local.path], null);
  assert.deepEqual(result.listed.map(groupKey), [groupKey(local), groupKey(box), 'repo:github.com/org/app']);
  assert.equal(result.listed[1].threads[0].id, 'machine');
});

test('checkouts verified against one remote repository retain each destination in the shared project', () => {
  const alias = `${box.path}/src`;
  const second = { ...box, path: '/other/checkout', threads: [chat('second', 3)] };
  const checkouts = [{ ...box, machineFolders: new Set([alias]) }, second];
  const result = groupRepositories(checkouts, new Set(checkouts.map(groupKey)), () => repo, [], [], [], null);
  assert.equal(result.listed.length, 1);
  assert.deepEqual(result.listed[0].machineGroups, checkouts.map(groupKey));
  assert.deepEqual(result.listed[0].machineFolderAliases, [groupKey({ ...box, path: alias })]);
  assert.deepEqual(
    result.listed[0].locations,
    checkouts.map(({ machine, path }) => ({ kind: 'machine', ...machine, path })),
  );
});

test('a configured cloud environment is a launch destination before it has tasks', () => {
  const result = groupRepositories([local], new Set([groupKey(local)]), () => repo, [], [env], [], null);
  assert.deepEqual(result.listed[0].locations, [{ kind: 'cloud', id: 'env', label: 'Build environment' }]);
  assert.deepEqual(result.listed.map(groupKey), ['saved-app']);
});

test('remote groups retain the canonical name and only trust a single well-formed repository', () => {
  const key = 'repo:github.com/org/app';
  const environments = [
    { id: 'env', label: 'Legacy environment', repo: 'org/app' },
    { id: '', label: null, repo: 'org/app' },
    null,
  ] as unknown as Parameters<typeof groupRepositories>[4];
  const grouped = groupRepositories([box], new Set([groupKey(box)]), () => repo, [task], environments, [], null);
  assert.equal(grouped.listed[0].name, 'app');
  assert.equal(grouped.listed[0].hint, 'org');
  assert.deepEqual(grouped.listed[0].locations, [
    { kind: 'machine', ...box.machine, path: box.path },
    { kind: 'cloud', id: 'env', label: 'Legacy environment' },
  ]);
  const hidden = groupRepositories([box], new Set([groupKey(box)]), () => repo, [task], environments, [key], null);
  assert.deepEqual(hidden.listed.map(groupKey), []);
  assert.deepEqual(hidden.cloud, [task]);
});

test('manual mixed row ordering places new rows ahead of the saved order', () => {
  const rows = projectRows([chat('listed', 10), chat('new', 3)], [task]);
  assert.deepEqual(
    sortProjectRows(rows, ['listed']).map((row) => row.key),
    ['new', 'cloud:task_a', 'listed'],
  );
});

test('repo comparison keeps path case on servers other than github.com', () => {
  assert.equal(sidebarRepository('git@GitLab.com:Org/App.git'), 'gitlab.com/Org/App');
  assert.equal(sidebarRepository('git@github.com:org/app.git/other'), 'github.com/org/app.git/other');
  assert.equal(sidebarRepository('git@github.com:org//app'), null);
});

test('a pinned repository keeps its checkout after its last active chat is gone', () => {
  const checkout = { ...box, threads: [] };
  const key = 'repo:github.com/org/app';
  const projected = groupRepositories([checkout], new Set(), () => repo, [], [], [], null, [key]);
  assert.deepEqual(projected.listed.map(groupKey), [key]);
  assert.deepEqual(projected.listed[0].machineGroups, [groupKey(box)]);
  assert.deepEqual(projected.listed[0].locations, [{ kind: 'machine', ...box.machine, path: box.path }]);
});

test('a repository gets its existing Custom position until the user orders it explicitly', () => {
  const first = { ...local, id: 'first' };
  const last = { ...local, id: 'last' };
  const key = 'repo:github.com/org/app';
  const result = groupRepositories([box], new Set([groupKey(box)]), () => repo, [task], [env], [], null);
  const merged = result.groups[0];
  const sourceOrder = ['first', groupKey(box), 'last'];
  assert.deepEqual(sortProjectGroups([first, last, merged], sourceOrder, [], 'custom').map(groupKey), ['first', key, 'last']);
  assert.deepEqual(sortProjectGroups([first, last, merged], ['first', 'last'], [], 'custom').map(groupKey), ['first', 'last', key]);
  assert.deepEqual(sortProjectGroups([first, last, merged], [...sourceOrder, key], [], 'custom').map(groupKey), ['first', 'last', key]);
});

test('Cloud activity joins the list without changing the chat order previously assigned to session families', () => {
  const rows = projectRows(
    [chat('family-head', 2), chat('solo', 90)],
    [
      { id: 'new-task', updated_at: 100 },
      { id: 'older-task', updated_at: 1 },
    ],
  );
  assert.deepEqual(
    mergeProjectRows(rows).map((row) => row.key),
    ['cloud:new-task', 'family-head', 'solo', 'cloud:older-task'],
  );
  assert.equal(cloudActivity({ updated_at: 1700000000000 }), 1700000000);
  assert.equal(cloudActivity({ updated_at: Infinity }), 0);
  assert.equal(cloudActivity({ updated_at: 'unavailable' }), 0);
});

test('an older Cloud task uncertain after reconfiguration stays available in the Cloud section', () => {
  const other = { ...task, id: 'older' };
  const result = groupRepositories([local], new Set([groupKey(local)]), () => repo, [task, other], [env], [], null, [], ['older']);
  assert.deepEqual(result.listed[0].cloudTasks, [task]);
  assert.deepEqual(result.cloud, [other]);
});

test('merged project rows retain starting sessions, machine pins and multiple verified Cloud environments', () => {
  const key = groupKey(box);
  const starting = { id: 'starting', name: 'Working', cwd: box.path, hostId: 'box', projectId: null, updatedAt: 20 };
  const source = { ...box, starting: [starting], pinnedKeys: [key] };
  const env2 = { ...env, id: 'env-two', label: 'Other environment' };
  const result = groupRepositories([local, source], new Set([key]), () => repo, [task], [env, env2], [], null);
  assert.deepEqual(result.listed[0].starting, [starting]);
  assert.deepEqual(result.listed[0].pinnedKeys, [key]);
  assert.deepEqual(
    result.listed[0].locations?.map((where) => where.id),
    ['box', env.id, env2.id],
  );
});

test('a pinned Cloud repository remains after its last task is gone', () => {
  const key = `repo:${repo}`;
  const result = groupRepositories([], new Set(), () => undefined, [], [env], [], null, [key]);
  assert.deepEqual(result.listed.map(groupKey), [key]);
  assert.deepEqual(result.listed[0].locations, [{ kind: 'cloud', id: env.id, label: env.label }]);
});

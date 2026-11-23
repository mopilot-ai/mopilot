// Cloud sidebar tasks and environment snapshots follow the account that requested them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, bootImpls } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test('a cloud environment reply from the previous account cannot regroup the current account’s tasks', async () => {
  const account = (email: string) => ({ type: 'chatgpt', email, planType: 'pro' }) as const;
  set({ account: account('first@example.test') });
  impl['cloud.list'] = async () => ({ tasks: [{ id: 'first', environment_id: 'env' }] });
  let finish!: (value: unknown) => void;
  impl['cloud.envs'] = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const earlier = S.loadCloudTasks();
  await Promise.resolve();
  await Promise.resolve();
  set({ account: account('second@example.test') });
  impl['cloud.list'] = async () => ({ tasks: [{ id: 'second', environment_id: 'env' }] });
  const expected = [{ id: 'env', repo: 'owner/second' }];
  impl['cloud.envs'] = async () => ({ envs: expected });
  await S.loadCloudTasks();
  finish({ envs: [{ id: 'env', repo: 'owner/first' }] });
  await earlier;
  assert.deepEqual(
    st().cloudTasks.map((task) => task.id),
    ['second'],
  );
  assert.deepEqual(st().cloudSidebar?.environments, expected);
});

test('identical polls keep the sidebar stable and old tasks do not move when an environment changes repositories', async () => {
  set({ account: { type: 'chatgpt', email: 'owner@example.test', planType: 'pro' } });
  let tasks = [{ id: 'old', environment_id: 'env' }];
  let repository = 'owner/first';
  impl['cloud.list'] = async () => ({ tasks: tasks.map((task) => ({ ...task })) });
  impl['cloud.envs'] = async () => ({ envs: [{ id: 'env', label: 'Environment', repo: repository }] });
  await S.loadCloudTasks();
  const initial = st();
  await S.loadCloudTasks();
  assert.equal(st().cloudTasks, initial.cloudTasks);
  assert.equal(st().cloudSidebar, initial.cloudSidebar);

  repository = 'owner/reconfigured';
  tasks = [...tasks, { id: 'new', environment_id: 'env' }];
  await S.loadCloudTasks();
  assert.deepEqual(st().cloudSidebar?.unplacedTasks, ['old']);
  assert.equal(st().cloudSidebar?.environments[0].repo, 'owner/reconfigured');
});

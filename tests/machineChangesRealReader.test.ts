// A machine's Changes pane through the real folder reader (electron/host/folders.cjs) over the real Host protocol (#5237): the files the Host names as in conflict reach the pane, which marks them and refuses to commit them. The fake Host replies of tests/changesConflictsUI.test.ts skip the reader, which is where `conflicted` was dropped.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, native, h, act, DiffPanel, settle, render, one } from './support/diff-panel-ui/fixture.ts';
import { waitFor } from './support/waitFor.ts';
import { realHostFolders } from './support/realHostFolders.ts';
import { machineChangesSource } from '../src/lib/machineChangesSource.ts';

const world = realHostFolders();
after(() => world.dispose());
const BOX = { id: 'ssh:me@box', name: 'box' };
const commits: unknown[] = [];
(native as any).host = {
  gitDiff: async (_id: string, q: any) => ({ value: await world.folders.diff('box', q) }),
  gitCommit: async (_id: string, q: unknown) => (commits.push(q), { value: { ok: true, stderr: '' } }),
  gitDiscard: async () => ({ value: { ok: true, stderr: '' } }),
  access: async () => true,
  onAccess: () => () => undefined,
  machines: async () => [],
  onMachines: () => () => undefined,
};
beforeEach(() => void (commits.length = 0));

const open = async (dir: string) => {
  store.set({ diffPanel: { scope: 'uncommitted' }, runtime: { t1: { turns: [] } }, prefs: {}, drafts: {} });
  const r = await render(h(DiffPanel, { cwd: dir, threadId: 't1', source: machineChangesSource(BOX, dir) }));
  // the real Host runs git: wait for the files to be drawn
  await waitFor(
    async () => {
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
      return r.host.querySelector('.cp-file');
    },
    'the files of the machine',
    { timeoutMs: 20_000 },
  );
  await settle(act);
  return r;
};

test('the reader hands the app the files the real Host names as in conflict', async () => {
  const dir = world.repo({ conflict: true });
  const diff = await world.folders.diff('box', { path: dir, scope: 'uncommitted' });
  assert.deepEqual(world.raw['git.diff'].conflicted, ['a.txt']);
  assert.deepEqual(diff.conflicted, ['a.txt']);
});

test('a conflicted file on a real machine is marked and cannot be ticked', async () => {
  const dir = world.repo({ conflict: true });
  const r = await open(dir);
  assert.equal(one(r.host, '.cp-file[data-path="a.txt"]').querySelector('.cp-file-badge.conflicted')?.textContent, 'Conflicted');
  assert.equal((one(r.host, '[aria-label="Include a.txt in the commit"]') as HTMLInputElement).disabled, true);
  await r.unmount();
});

test('a folder with no conflict lists none and marks nothing', async () => {
  const dir = world.repo();
  const diff = await world.folders.diff('box', { path: dir, scope: 'uncommitted' });
  assert.deepEqual(diff.conflicted, []);
  const r = await open(dir);
  assert.equal(r.host.querySelectorAll('.cp-file').length > 0, true, 'the files are drawn');
  assert.equal(r.host.querySelectorAll('.cp-file-badge.conflicted').length, 0);
  await r.unmount();
});

test('a Host that sends no conflicted list (an older one) marks none', async () => {
  const dir = world.repo({ conflict: true });
  const real = (native as any).host.gitDiff;
  (native as any).host.gitDiff = async (_id: string, q: any) => {
    const { conflicted: _dropped, ...older } = (await world.folders.diff('box', q)) as any;
    return { value: older };
  };
  const r = await open(dir);
  assert.equal(r.host.querySelectorAll('.cp-file').length > 0, true, 'the files are drawn');
  assert.equal(r.host.querySelectorAll('.cp-file-badge.conflicted').length, 0);
  await r.unmount();
  (native as any).host.gitDiff = real;
});

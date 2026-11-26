// The PR reader finds a branch's PR in the repository the branch is pushed to when origin's repository cannot answer (a deleted origin) or has none: on a machine through its Host's upstream, on this Mac through the checkout's git config.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';

const PR = { url: 'https://github.com/o/internal/pull/5700', state: 'MERGED', title: 'Warm palette', isCrossRepository: false };
const DEAD = { ok: false, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'o/deleted'. (repository)" };
const ghCalls: { cwd: string; args: string[] }[] = [];
const gitCalls: { cwd: string; args: string[] }[] = [];
let gh: (args: string[]) => { ok: boolean; stdout: string; stderr?: string };
let tracked = 'internal\0refs/heads/feat-up\n';
let status: () => Promise<unknown>;
const URLS = 'remote.origin.url https://github.com/o/deleted.git\nremote.internal.url https://github.com/o/internal.git\n';
installNativeStub({
  git: {
    run: async (cwd: string, args: string[]) => {
      gitCalls.push({ cwd, args });
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'feat\n' };
      if (args[0] === 'for-each-ref') return { ok: true, stdout: tracked };
      return { ok: true, stdout: URLS };
    },
    gh: async (cwd: string, args: string[]) => (ghCalls.push({ cwd, args }), gh(args)),
  },
  host: { gitStatus: async () => status() },
  prMonitor: { snapshot: async () => null },
  pullRequests: { savedReplies: async () => [], saveReplies: async () => undefined },
  peer: { referenceHistory: async ([id]: string[]) => ({ [id]: { turns: [] } }) },
  fs: { configRoots: async () => ({ codexHome: '/codex' }), readText: async () => null },
});
stubStore({ nativeOf: (id: string) => id, useStore: Object.assign(() => null, { getState: () => ({ home: '/home', runtime: {} }) }) });
mock.module('../src/lib/windowReady.ts', { namedExports: { windowIsReady: () => true, windowReady: async () => undefined } });
const { readPullRequest } = await import('../src/session/pullRequestReader.ts');
const { resetMachineBranches } = await import('../src/lib/machinePullRequest.ts');

let seq = 0;
const read = (cwd: string) => readPullRequest('acp:host-claude:chat', cwd, true, `v${++seq}`);
const repoOf = (args: string[]) => args.find((a) => a.startsWith('--repo='));

beforeEach(() => {
  ghCalls.length = 0;
  gitCalls.length = 0;
  resetMachineBranches();
  tracked = 'internal\0refs/heads/feat-up\n';
  status = async () => ({
    value: {
      isRepo: true,
      branch: 'feat',
      head: 'a'.repeat(40),
      remote: 'https://github.com/o/deleted.git',
      upstream: { remote: 'https://github.com/o/internal.git', branch: 'feat-up' },
      files: [],
      truncated: false,
      unreadable: false,
    },
  });
  gh = (args) => (args[1] === 'view' || repoOf(args) === '--repo=github.com/o/deleted' ? DEAD : { ok: true, stdout: JSON.stringify([PR]) });
});

test('a chat on a machine whose origin is deleted takes its PR from the repository its branch is pushed to', async () => {
  const pr = await read(machineFolderKey('m1', `/srv/app${seq}`));
  assert.deepEqual([pr?.url, pr?.state], [PR.url, 'merged']);
  assert.deepEqual(
    ghCalls.map((c) => [c.cwd, repoOf(c.args), c.args.find((a) => a.startsWith('--head='))]),
    [
      ['/home', '--repo=github.com/o/deleted', '--head=feat'],
      ['/home', '--repo=github.com/o/internal', '--head=feat-up'],
    ],
  );
});

test('a chat on this Mac whose origin is deleted takes its PR from the repository its branch is pushed to, read in its folder', async () => {
  const cwd = `/work/app${seq}`;
  const pr = await read(cwd);
  assert.deepEqual([pr?.url, pr?.state], [PR.url, 'merged']);
  assert.deepEqual(
    ghCalls.map((c) => [c.cwd, c.args[1], repoOf(c.args)]),
    [
      [cwd, 'view', undefined],
      [cwd, 'list', '--repo=github.com/o/internal'],
    ],
  );
  assert.ok(gitCalls.every((c) => c.cwd === cwd));
});

test("gh's own answer stands without reading the branch's remotes, and a branch pushed nowhere else keeps gh's failure", async () => {
  gh = () => ({ ok: true, stdout: JSON.stringify(PR) });
  assert.equal((await read(`/work/app${seq}`))?.url, PR.url);
  assert.deepEqual(
    gitCalls.map((c) => c.args[0]),
    ['symbolic-ref', 'symbolic-ref'],
  );
  gh = () => DEAD;
  tracked = 'origin\0refs/heads/feat\n';
  ghCalls.length = 0;
  assert.equal(await read(`/work/app${seq}`), null);
  assert.deepEqual(
    ghCalls.map((c) => c.args[1]),
    ['view'],
  );
});

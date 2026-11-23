// The branch and repository of a chat's folder on a machine, as its Host's git.status says them: one read shared while it stands, none remembered when the Host could not answer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';

let reply: () => Promise<unknown>;
const asked: unknown[][] = [];
installNativeStub({
  host: {
    gitStatus: (...a: unknown[]) => (asked.push(a), reply()),
  },
});
const { machineBranch, repoOfRemote, resetMachineBranches, MACHINE_BRANCH_TTL } = await import('../src/lib/machinePullRequest.ts');

const repo = (remote: string | null, branch: string | null = 'feat') => ({
  value: { isRepo: true, branch, head: 'a'.repeat(40), remote, files: [], truncated: false, unreadable: false },
});
const key = machineFolderKey('m1', '/srv/app');

beforeEach(() => {
  resetMachineBranches();
  asked.length = 0;
  reply = async () => repo('https://github.com/o/r');
});

test('the Host answers the branch and the repository of the folder, asked for that machine and path', async () => {
  assert.deepEqual(await machineBranch(key), { branch: 'feat', repo: 'github.com/o/r' });
  assert.deepEqual(asked, [['m1', { path: '/srv/app' }]]);
});

test('a plain path of this Mac is no machine folder and asks nobody', async () => {
  assert.equal(await machineBranch('/work/app'), null);
  assert.deepEqual(asked, []);
});

test('rows and menus asking inside the window share one read; the window passes and the next asks again', async () => {
  let clock = 1_000;
  const now = () => clock;
  const first = machineBranch(key, now);
  const second = machineBranch(key, now);
  assert.deepEqual(await Promise.all([first, second]), [
    { branch: 'feat', repo: 'github.com/o/r' },
    { branch: 'feat', repo: 'github.com/o/r' },
  ]);
  clock += MACHINE_BRANCH_TTL - 1;
  await machineBranch(key, now);
  assert.equal(asked.length, 1);
  // another folder is another read
  await machineBranch(machineFolderKey('m2', '/srv/app'), now);
  assert.equal(asked.length, 2);
  clock += 1;
  reply = async () => repo('https://github.com/o/r', 'other');
  assert.deepEqual(await machineBranch(key, now), { branch: 'other', repo: 'github.com/o/r' });
  assert.equal(asked.length, 3);
});

test('a folder that is no repository, has no branch (detached) or no GitHub remote answers null, and that answer stands', async () => {
  for (const answer of [{ value: { isRepo: false } }, repo('https://github.com/o/r', null), repo(null), repo('/srv/other.git')]) {
    resetMachineBranches();
    asked.length = 0;
    reply = async () => answer;
    assert.equal(await machineBranch(key), null);
    assert.equal(await machineBranch(key), null);
    assert.equal(asked.length, 1);
  }
});

test('a Host that cannot answer (a refusal, an old Host, offline) says nothing and is asked again, never an error', async () => {
  reply = async () => ({ error: { message: 'Update the Host on that machine.', code: 'host_outdated' } });
  assert.equal(await machineBranch(key), null);
  reply = async () => {
    throw new Error('offline');
  };
  assert.equal(await machineBranch(key), null);
  assert.equal(asked.length, 2);
  reply = async () => repo('git@github.com:o/r.git');
  assert.deepEqual(await machineBranch(key), { branch: 'feat', repo: 'github.com/o/r' });
});

test('a failed read in flight does not delete the newer entry that replaced it', async () => {
  let release!: (v: unknown) => void;
  reply = () => new Promise((r) => (release = r));
  const old = machineBranch(key, () => 0);
  // the window passed, so a second read replaces the first entry while the first is still out
  reply = async () => repo('https://github.com/o/r', 'newer');
  assert.deepEqual(await machineBranch(key, () => MACHINE_BRANCH_TTL), { branch: 'newer', repo: 'github.com/o/r' });
  release({ error: { message: 'late' } });
  assert.equal(await old, null);
  // the newer answer is still the one kept
  assert.deepEqual(await machineBranch(key, () => MACHINE_BRANCH_TTL), { branch: 'newer', repo: 'github.com/o/r' });
  assert.equal(asked.length, 2);
});

test('a repository is named from an https, ssh or scp address, and nothing else', () => {
  assert.equal(repoOfRemote('https://github.com/o/r'), 'github.com/o/r');
  assert.equal(repoOfRemote('https://GitHub.com/o/r.git/'), 'github.com/o/r');
  assert.equal(repoOfRemote('ssh://git@github.com/o/r.git'), 'github.com/o/r');
  assert.equal(repoOfRemote('ssh://github.com/o/r'), 'github.com/o/r');
  assert.equal(repoOfRemote('git@ghe.example.com:team/app.git'), 'ghe.example.com/team/app');
  for (const bad of [null, '', '/srv/repo.git', 'https://github.com/o', 'https://github.com/o/r/extra', 'file:///x/y']) {
    assert.equal(repoOfRemote(bad), null, String(bad));
  }
});

// electron/platform/worktreeAdopt.cjs listAdopted with a real repository: the worktrees brought over in place, as git lists them now, through git:worktreeAdopted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');

test('only adopted worktrees of the folder’s repository are listed, each with the branch it has now', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtlist-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'app');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd });
  run(repo, 'init', '--quiet', '--initial-branch=trunk');
  fs.writeFileSync(path.join(repo, 'sub', 'a.txt'), 'a');
  run(repo, 'add', '.');
  run(repo, 'commit', '--quiet', '-m', 'first');
  const tokyo = path.join(home, 'conductor', 'tokyo');
  const lima = path.join(home, 'conductor', 'lima');
  run(repo, 'worktree', 'add', '--quiet', '-b', 'feat/tokyo', tokyo);
  run(repo, 'worktree', 'add', '--quiet', '-b', 'feat/lima', lima);
  const handlers = new Map<string, (...a: any[]) => any>();
  git.register({ handle: (ch: string, f: any) => handlers.set(ch, f) });
  const list = (cwd: unknown) => handlers.get('git:worktreeAdopted')!({}, cwd);
  // none adopted yet
  assert.deepEqual(await list(repo), []);
  // git cannot say: not "none"
  assert.equal(await list('app'), null);
  assert.equal(await list(undefined), null);
  assert.equal(await list(home), null);
  assert.equal(git.worktreeAdopt(tokyo).ok, true);
  // asked from a folder inside the repository, and from the workspace itself
  const one = [{ path: tokyo, name: 'tokyo', branch: 'feat/tokyo' }];
  assert.deepEqual(await list(path.join(repo, 'sub')), one);
  assert.deepEqual(await list(tokyo), one);
  // the branch is read now, and a workspace removed since is gone from the list
  run(tokyo, 'switch', '--quiet', '-c', 'feat/kyoto');
  assert.deepEqual(await list(repo), [{ path: tokyo, name: 'tokyo', branch: 'feat/kyoto' }]);
  run(repo, 'worktree', 'remove', '--force', tokyo);
  assert.deepEqual(await list(repo), []);
});

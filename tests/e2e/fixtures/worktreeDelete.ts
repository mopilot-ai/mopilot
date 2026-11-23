// Deleting a worktree from outside the app, as a user would, on every platform.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect } from './app';

const worktrees = (repo: string) =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;

/**
 * Deletes `worktree` and has `repo`'s git forget it, which `git worktree remove --force` does in one step. On Windows a
 * process the app just started there can hold the folder for a moment, and Windows refuses the delete until it lets go
 * (win-e2e runs 43609939096 and 43610383130). fs.rmSync retries EBUSY and EPERM, waiting 100 ms longer each time:
 * 17 retries wait about 15 s in all.
 */
export function deleteWorktree(repo: string, worktree: string) {
  const before = worktrees(repo);
  fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' });
  expect(worktrees(repo), 'git no longer lists the deleted worktree').toBe(before - 1);
}

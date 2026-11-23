// Linked fresh worktrees retain their source branch, while a fork takes the parent's local committed tip without remote ref refresh.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const calls: string[][] = [];
mock.method(childProcess, 'execFile', (_command: string, args: string[], _opts: unknown, cb: any) => {
  calls.push(args);
  let text = '';
  if (args.includes('--show-toplevel')) text = '/repo\n';
  if (args[0] === 'symbolic-ref') text = 'origin/release\n';
  setImmediate(() => cb(null, text, ''));
});

test('fresh metadata keeps its selected source and fork placement uses HEAD without fetching or changing its base', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-worktree-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fresh = await git.worktreeAdd('/repo', { root: path.join(root, 'fresh'), branch: 'release' });
  assert.equal(fresh.ok, true);
  assert.equal(calls.at(-1)?.at(-1), 'origin/release');
  assert.equal(git.worktreeInfo(fresh.path).sourceBranch, 'release');
  calls.length = 0;
  const fork = await git.worktreeAdd(fresh.path, { root: path.join(root, 'fork'), startPoint: 'head' });
  assert.equal(fork.ok, true);
  assert.equal(calls.at(-1)?.at(-1), 'HEAD');
  assert.equal(
    calls.some((args) => args[0] === 'fetch'),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === 'symbolic-ref'),
    false,
    'the parent marker owns its base, not today’s remote default',
  );
  assert.equal(git.worktreeInfo(fork.path).sourceBranch, 'release');
  calls.length = 0;
  const plain = await git.worktreeAdd('/repo', { root: path.join(root, 'plain'), startPoint: 'head' });
  assert.equal(plain.ok, true);
  assert.equal(calls.at(-1)?.at(-1), 'HEAD');
  assert.equal(git.worktreeInfo(plain.path).sourceBranch, 'release');
});

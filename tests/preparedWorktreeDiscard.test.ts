// Cancelled starts may remove only their own clean prepared worktrees; Git and filesystem failures preserve user work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { discardWorktree } = require('../electron/platform/discardWorktree.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');

test('cleanup uses no force and removes only the empty owned holder, retaining dirty worktrees or other files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discard-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wt = { worktree: path.join(root, 'holder', 'repo'), repo: '/repo' };
  const calls: any[] = [];
  const run = async (...a: any[]) => (calls.push(a), { ok: true });
  await fs.mkdir(path.dirname(wt.worktree));
  await fs.writeFile(path.join(root, 'holder', '.mopilot-worktree.json'), '{}');
  assert.deepEqual(await discardWorktree(wt, { run }), { discarded: true });
  assert.deepEqual(calls[0], [['worktree', 'remove', wt.worktree], wt.repo]);
  await assert.rejects(fs.stat(path.dirname(wt.worktree)), { code: 'ENOENT' });
  await fs.mkdir(path.dirname(wt.worktree));
  await fs.writeFile(path.join(root, 'holder', '.mopilot-worktree.json'), '{}');
  await fs.writeFile(path.join(root, 'holder', 'user-file'), 'keep');
  assert.equal((await discardWorktree(wt, { run })).discarded, true);
  assert.equal(await fs.readFile(path.join(root, 'holder', 'user-file'), 'utf8'), 'keep');
  const retained = await discardWorktree(wt, { run: async () => ({ ok: false }) });
  assert.equal(retained.discarded, false);
  assert.match(retained.reason, /local changes are kept/);
});

test('starter ownership is required, a successful child releases it and a cleanup failure remains retryable', async () => {
  let outcome: any = { discarded: false };
  const calls: any[] = [];
  const starter = new ChatStarter({
    prefs: () => ({}),
    worktree: async () => ({ ok: true, path: '/prepared', worktree: '/prepared', repo: '/missing-repo' }),
    discardWorktree: async (wt: any) => {
      calls.push(wt);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  assert.equal((await starter.discardWorktree('/parent')).discarded, false);
  await starter.newWorktree('/parent');
  assert.equal((await starter.discardWorktree('/prepared')).discarded, false);
  outcome = new Error('unavailable');
  assert.equal((await starter.discardWorktree('/prepared')).discarded, false);
  outcome = { discarded: true };
  assert.equal((await starter.discardWorktree('/prepared')).discarded, true);
  assert.equal((await starter.discardWorktree('/prepared')).discarded, false);
  await starter.newWorktree('/parent');
  assert.equal(starter.retainWorktree('/prepared'), true);
  assert.equal((await starter.discardWorktree('/prepared')).discarded, false);
  await starter.newWorktree('/parent');
  delete starter.o.discardWorktree;
  assert.equal((await starter.discardWorktree('/prepared')).discarded, false);
  assert.equal(calls.length, 3);
});

test('a committed fork passes its exact HEAD placement through the real starter before native allocation', async () => {
  const calls: any[] = [];
  const starter = new ChatStarter({
    prefs: () => ({ worktreeRoot: '/managed', branchPrefix: 'work/' }),
    worktree: async (...args: any[]) => {
      calls.push(args);
      return { ok: false, unsupported: true, error: 'Repository unavailable' };
    },
  });
  assert.deepEqual(await starter.newWorktree('/parent', { branch: 'feature', startPoint: 'head' }), {
    unsupported: 'Repository unavailable',
  });
  assert.deepEqual(calls, [['/parent', { prefix: 'work/', root: '/managed', branch: 'feature', startPoint: 'head' }]]);
});

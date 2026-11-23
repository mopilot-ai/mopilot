// Security review of Mobile Remote: a phone's review requests start git processes on the Mac, so a flood of them may not start a flood of processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-load-')));
const { createReviewOps, GIT_MAX_PARALLEL } = require('../electron/remote/review/ops.cjs');

test('git reads run a few at a time however many requests arrive, and all of them finish', async () => {
  let running = 0;
  let peak = 0;
  let started = 0;
  const run = async (_cmd: string, args: string[]) => {
    started++;
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setImmediate(r));
    running--;
    // rev-parse names the repository; anything else is an empty, successful diff
    return { ok: true, stdout: args[0] === 'rev-parse' ? `${repo}\n` : '', stderr: '' };
  };
  const review = createReviewOps({
    cwdOf: async () => repo,
    live: { chats: { records: new Map() }, controller: {} },
    history: async () => ({ turns: [] }),
    run,
  });
  const results = await Promise.all(Array.from({ length: 60 }, () => review.files({ cwd: repo, scope: 'uncommitted' })));
  assert.equal(results.length, 60);
  assert.ok(started >= 60, 'every request read the repository');
  assert.ok(peak <= GIT_MAX_PARALLEL, `${peak} git processes at once`);
});

test('a git read that throws frees its place', async () => {
  const run = async () => {
    throw new Error('spawn failed');
  };
  const review = createReviewOps({
    cwdOf: async () => repo,
    live: { chats: { records: new Map() }, controller: {} },
    history: async () => ({ turns: [] }),
    run,
  });
  for (let i = 0; i < GIT_MAX_PARALLEL * 3; i++) await assert.rejects(review.files({ cwd: repo, scope: 'uncommitted' }), /spawn failed/);
});

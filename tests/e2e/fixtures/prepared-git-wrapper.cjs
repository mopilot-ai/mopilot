#!/usr/bin/env node
// Delegates every Git command to the captured real executable, holding only a scratch-owned non-force worktree removal.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removalTarget } = require('./prepared-native-gate.cjs');

const args = process.argv.slice(2);
const realGit = process.env.MOPILOT_TEST_REAL_GIT;
if (!realGit) throw new Error('The Git gate requires a captured real Git executable');
const log = process.env.FAKE_CODEX_LOG;
const target = log && removalTarget(args, path.join(process.env.HOME, '.mopilot', 'worktrees'));
if (target) {
  fs.writeFileSync(`${log}.prepared-git.entered`, JSON.stringify({ args, cwd: process.cwd(), target }));
  const deadline = Date.now() + Number(process.env.MOPILOT_TEST_GIT_GATE_TIMEOUT ?? 20_000);
  while (!fs.existsSync(`${log}.prepared-git.release`)) {
    if (Date.now() >= deadline) {
      fs.writeFileSync(`${log}.prepared-git.done`, JSON.stringify({ timedOut: true }));
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const result = spawnSync(realGit, args, { stdio: 'inherit' });
if (target) fs.writeFileSync(`${log}.prepared-git.done`, JSON.stringify({ status: result.status, error: result.error?.message ?? null }));
process.exit(result.status ?? 1);

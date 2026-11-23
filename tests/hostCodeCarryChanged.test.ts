// A carry plan names the files git already knew as well as the new ones (F3 of the VM journey), at most fifty of them, while its count says all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { planCarry } from '../shared/host/codeCarry.mjs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  });
const gitIn = (cwd: string) => async (args: string[]) => {
  try {
    return { ok: true, stdout: String(git(cwd, ...args)), stderr: '' };
  } catch (e: any) {
    return { ok: false, stdout: '', stderr: String(e.stderr ?? e.message) };
  }
};

test('a plan names the files git already knew, at most fifty of them, and the count says the rest', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-changed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main');
  const names = Array.from({ length: 53 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'many files');
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'two\n');
  fs.writeFileSync(path.join(dir, 'brand-new.txt'), 'new\n');
  const plan = await planCarry(gitIn(dir));
  assert.equal(plan.files, 54);
  assert.equal(plan.changed.length, 50);
  assert.deepEqual(plan.untracked, ['brand-new.txt']);
  assert.ok(plan.changed.every((f: string) => names.includes(f)));
});

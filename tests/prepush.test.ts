// scripts/prepush.mjs: the pre-push hook refuses pushes that update or delete main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED, prepush, protectedRefs } from '../scripts/prepush.mjs';

// Under a git hook or `rebase --exec` these point git at the developer's repository; the real push below must only
// touch its temporary ones.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete process.env[name];

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('only main on the remote is protected, whatever the local ref is called', () => {
  assert.equal(PROTECTED, 'refs/heads/main');
  assert.deepEqual(protectedRefs(''), []);
  assert.deepEqual(protectedRefs(`refs/heads/feature ${A} refs/heads/feature ${B}\n`), []);
  // a branch named after main elsewhere, and main pushed to another name, are fine
  assert.deepEqual(protectedRefs(`refs/heads/main ${A} refs/heads/bwang/main-sync ${ZERO}\n`), []);
  assert.deepEqual(protectedRefs(`refs/heads/x ${A} refs/heads/feature/main ${B}\n`), []);
  assert.deepEqual(protectedRefs(`refs/heads/x ${A} refs/tags/main ${B}\n`), []);
  // HEAD:main, an update, and a deletion all change main
  assert.deepEqual(protectedRefs(`HEAD ${A} refs/heads/main ${B}\n`), [PROTECTED]);
  assert.deepEqual(protectedRefs(`(delete) ${ZERO} refs/heads/main ${B}\n`), [PROTECTED]);
  assert.deepEqual(protectedRefs(`refs/heads/f ${A} refs/heads/f ${ZERO}\nrefs/heads/main ${A} refs/heads/main ${B}\n`), [PROTECTED]);
});

test('prepush refuses main with the way forward, and passes everything else', () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  assert.equal(prepush(`refs/heads/f ${A} refs/heads/f ${ZERO}\n`, 'origin', log), 0);
  assert.deepEqual(logs, []);
  assert.equal(prepush(`refs/heads/main ${A} refs/heads/main ${B}\n`, 'origin', log), 1);
  assert.match(logs[0], /^pre-push: refusing to push to main on origin\. .*pull request .*`unit-tests`.* --no-verify\.$/);
});

test('the command line reads the refs from standard input', () => {
  const run = (input: string, args: string[] = ['origin']) =>
    spawnSync(process.execPath, ['scripts/prepush.mjs', ...args], { input, encoding: 'utf8' });
  assert.equal(run(`refs/heads/f ${A} refs/heads/f ${ZERO}\n`).status, 0);
  const refused = run(`HEAD ${A} refs/heads/main ${B}\n`, []);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to push to main on the remote\./);
});

test('the hook refuses a real push to main and lets a branch through', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'init', '-q', '-b', 'main', work);
  // whole-file paths, so the open-source export keeps this test with the hook it covers (scripts/oss-tooling.mjs)
  for (const file of ['scripts/prepush.mjs', '.githooks/pre-push']) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.copyFileSync(file, path.join(work, file));
  }
  git(work, 'config', 'core.hooksPath', '.githooks');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'remote', 'add', 'origin', remote);
  const main = git(work, 'push', 'origin', 'main');
  assert.notEqual(main.status, 0);
  assert.match(main.stderr, /refusing to push to main on origin/);
  assert.equal(git(work, 'push', '-q', 'origin', 'main:refs/heads/feature').status, 0);
  assert.equal(git(work, 'push', '-q', '--no-verify', 'origin', 'main').status, 0);
});

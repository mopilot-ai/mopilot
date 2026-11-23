// The git the Host runs (host/src/hostGit.mjs runGit) cannot be made to run a repository's code: an embedded bare repository is not entered, a hook does not run, and the environment cannot point git elsewhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { GIT_HARDENING, gitEnv, hardenedArgs, runGit } from '../host/src/hostGit.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-hard-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...args], { cwd, encoding: 'utf8' });

/** A repository with one commit. */
function repo(name: string) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

test('a folder that holds a bare repository is not entered: git refuses it instead of reading its config and hooks', async () => {
  const outer = repo('outer');
  // a repository a hostile project committed as a folder: HEAD, objects, refs and a config of its own
  const evil = path.join(outer, 'evil');
  git(base, 'init', '-q', '--bare', evil);
  assert.equal(git(evil, 'rev-parse', '--is-bare-repository').stdout.trim(), 'true', 'a plain git enters it');
  const r = await runGit(['rev-parse', '--is-bare-repository'], { cwd: evil });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /cannot use bare repository/);
});

test('a hook of the repository does not run when the Host adds a worktree', async () => {
  const dir = repo('hooked');
  const marker = path.join(base, 'hook-ran');
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  // the hook is live for a plain git ...
  git(dir, 'worktree', 'add', '-q', path.join(base, 'wt-plain'), '-b', 'plain');
  assert.ok(fs.existsSync(marker), 'a plain git runs the hook');
  fs.rmSync(marker);
  // ... and not for the Host's
  const r = await runGit(['worktree', 'add', '-q', path.join(base, 'wt-host'), '-b', 'host'], { cwd: dir });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test('an fsmonitor of the repository does not run', async () => {
  const dir = repo('monitored');
  const marker = path.join(base, 'monitor-ran');
  fs.writeFileSync(path.join(base, 'monitor.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(dir, 'config', 'core.fsmonitor', path.join(base, 'monitor.sh'));
  const r = await runGit(['status', '--porcelain'], { cwd: dir });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test('the ext transport is refused, and https, ssh and local paths are the ones a clone may use', async () => {
  const dir = path.join(base, 'ext-dest');
  const r = await runGit(['clone', '--', 'ext::sh -c "touch /tmp/host-git-ext-ran"', dir]);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync('/tmp/host-git-ext-ran'), false);
  const local = repo('source');
  const ok = await runGit(['clone', '-q', '--', local, path.join(base, 'cloned')]);
  assert.equal(ok.ok, true, ok.stderr);
});

test('the environment cannot point git at another repository or config, and the caller’s variables still pass', () => {
  const env = gitEnv(
    {
      PATH: '/bin',
      GIT_DIR: '/x',
      GIT_WORK_TREE: '/y',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_EXTERNAL_DIFF: 'x',
      GIT_INDEX_FILE: '/z',
      GIT_ASKPASS: 'askpass',
    },
    { GIT_INDEX_FILE: '/tmp/idx' },
  );
  assert.deepEqual(env, {
    PATH: '/bin',
    GIT_ASKPASS: 'askpass',
    GIT_INDEX_FILE: '/tmp/idx',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'https:ssh:file',
  });
  assert.deepEqual(hardenedArgs(['status']).slice(-1), ['status']);
  assert.equal(hardenedArgs([]).length, GIT_HARDENING.length * 2);
});

test('a git that cannot start resolves as a failure', async () => {
  const r = await runGit(['status'], { cwd: path.join(base, 'does-not-exist') });
  assert.equal(r.ok, false);
});

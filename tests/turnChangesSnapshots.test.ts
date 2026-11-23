// Private Git snapshot cache and index ownership cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { TurnChanges } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

test('snapshot keeps cached stats for unchanged tracked files while leaving the real index untouched', async () => {
  const { chmod } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'turn-changes-stat-cache-'));
  const cwd = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const savedPath = process.env.PATH;
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const trace = join(dir, 'cache-stats');
  try {
    await mkdir(cwd);
    await mkdir(bin);
    const git = (...args: string[]) => execFileSync(realGit, ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    await writeFile(join(cwd, 'sentinel.txt'), 'unchanged\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const index = await readFile(join(cwd, '.git/index'));
    // Observe the private index BEFORE git add, so repeated full hashing cannot quietly return.
    await writeFile(
      join(bin, 'git'),
      `#!${process.execPath}
const {spawnSync, execFileSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
if (result.status === 0 && args[0] === 'read-tree') appendFileSync(${JSON.stringify(trace)}, execFileSync(${JSON.stringify(realGit)}, ['ls-files', '--debug', '--', 'sentinel.txt']));
process.exit(result.status ?? 1);
`,
    );
    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const changes = new TurnChanges();
    await changes.begin('cached', cwd);
    const stats = await readFile(trace, 'utf8');
    assert.match(stats, /mtime: [1-9][0-9]*:/, 'unchanged files retain cached mtime before staging');
    assert.deepEqual(await readFile(join(cwd, '.git/index')), index);
    assert.equal(await changes.finish('cached'), '');
  } finally {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('cached snapshots restore HEAD tracked-ignored paths and handle split indexes and linked worktrees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-changes-worktree-cache-'));
  const cwd = join(dir, 'repo');
  const linked = join(dir, 'linked');
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    await writeFile(join(cwd, '.gitignore'), '*.ignored\n');
    await writeFile(join(cwd, 'tracked.ignored'), 'original\n');
    await writeFile(join(cwd, 'source.txt'), 'original\n');
    git('add', '-f', '.gitignore', 'tracked.ignored', 'source.txt');
    git('commit', '-qm', 'baseline');
    git('worktree', 'add', '-qb', 'linked', linked);
    git('rm', '--cached', 'tracked.ignored');
    git('update-index', '--split-index');
    const index = await readFile(join(cwd, '.git/index'));
    const changes = new TurnChanges();
    await changes.begin('split', cwd);
    await writeFile(join(cwd, 'tracked.ignored'), 'agent edit\n');
    assert.match(await changes.finish('split'), /-original\n\+agent edit/);
    assert.deepEqual(await readFile(join(cwd, '.git/index')), index);
    await changes.begin('linked', linked);
    await writeFile(join(linked, 'source.txt'), 'linked edit\n');
    const diff = await changes.finish('linked');
    assert.match(diff, /-original\n\+linked edit/);
    assert.doesNotMatch(diff, /agent edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const hint of ['--assume-unchanged', '--skip-worktree']) {
  test(`a user's ${hint} hint cannot hide edits from private turn snapshots`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-index-hint-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'UT');
      git('config', 'user.email', 'ut@example.invalid');
      await writeFile(join(cwd, 'source.txt'), 'committed\n');
      git('add', '.');
      git('commit', '-qm', 'baseline');
      git('update-index', hint, 'source.txt');
      await writeFile(join(cwd, 'source.txt'), 'preexisting work\n');
      const index = await readFile(join(cwd, '.git/index'));
      const changes = new TurnChanges();
      await changes.begin('hinted', cwd);
      await writeFile(join(cwd, 'source.txt'), 'agent work\n');
      const diff = await changes.finish('hinted');
      assert.match(diff, /-preexisting work\n\+agent work/);
      assert.doesNotMatch(diff, /-committed/);
      assert.deepEqual(await readFile(join(cwd, '.git/index')), index);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('private index seeding preserves racy-clean detection for same-size baseline and agent edits', async () => {
  const { utimes } = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-racy-index-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    git('config', 'core.trustctime', 'false');
    const file = join(cwd, 'source.txt');
    const indexPath = join(cwd, '.git/index');
    const stamp = new Date(Date.now() - 20000);
    await writeFile(file, 'old\n');
    await utimes(file, stamp, stamp);
    git('add', '.');
    git('commit', '-qm', 'baseline');
    await utimes(indexPath, stamp, stamp);
    const index = await readFile(indexPath);
    await writeFile(file, 'new\n');
    await utimes(file, stamp, stamp);
    const changes = new TurnChanges();
    await changes.begin('racy', cwd);
    assert.equal(git('show', `${changes.baselines.get('racy').tree}:source.txt`), 'new\n');
    await writeFile(file, 'fix\n');
    await utimes(file, stamp, stamp);
    assert.match(await changes.finish('racy'), /-new\n\+fix/);
    assert.deepEqual(await readFile(indexPath), index);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sparse snapshots capture outside-cone edits without attributing absent files or changing the user index', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-sparse-index-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    await mkdir(join(cwd, 'inside'));
    await mkdir(join(cwd, 'outside'));
    await writeFile(join(cwd, 'inside', 'visible.txt'), 'inside\n');
    await writeFile(join(cwd, 'outside', 'present.txt'), 'old\n');
    await writeFile(join(cwd, 'outside', 'absent.txt'), 'keep\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    git('sparse-checkout', 'init', '--cone', '--sparse-index');
    git('sparse-checkout', 'set', 'inside');
    await mkdir(join(cwd, 'outside'), { recursive: true });
    await writeFile(join(cwd, 'outside', 'present.txt'), 'preexisting\n');
    const index = await readFile(join(cwd, '.git/index'));
    const changes = new TurnChanges();
    await changes.begin('sparse', cwd);
    const baseline = changes.baselines.get('sparse').tree;
    assert.equal(git('show', `${baseline}:outside/present.txt`), 'preexisting\n');
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(join(cwd, 'outside', 'absent.txt')));
    await writeFile(join(cwd, 'outside', 'present.txt'), 'agent\n');
    const diff = await changes.finish('sparse');
    assert.match(diff, /-preexisting\n\+agent/);
    assert.doesNotMatch(diff, /absent.txt|visible.txt/);
    assert.deepEqual(await readFile(join(cwd, '.git/index')), index);
    await assert.rejects(access(join(cwd, 'outside', 'absent.txt')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Exercises lint-fixture admission against real Git index states independently of working-tree cleanup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { precommit } from '../scripts/precommit.mjs';

function repository(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'precommit-fixtures-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (file: string, text = 'export const fixture = 1;\n') => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const remove = (file: string) => rmSync(path.join(dir, file));
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture Test', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-verify', '-qm', 'baseline');
  };
  const check = () => {
    const logs: string[] = [];
    const checks: string[] = [];
    const status = precommit({
      run: (cmd: string, args: string[]) => {
        if (cmd === 'git') return spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
        checks.push([cmd, ...args].join(' '));
        return { status: 0 };
      },
      log: (s: string) => logs.push(s),
    });
    return { status, logs, checks };
  };
  git('init', '-q', '--template=');
  git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
  git('config', 'commit.gpgSign', 'false');
  git('config', 'diff.renames', 'true');
  return { dir, git, write, remove, commit, check };
}

test('fixtures surviving in the index are rejected after their working file is removed (#1507)', async (t) => {
  for (const kind of ['A', 'M', 'R', 'T']) {
    await t.test(kind, (t) => {
      const repo = repository(t);
      const fixture = 'src/styles/.lint-fixture-space tab\tline\n/Inline.tsx';
      repo.write('src/source.ts');
      if (kind === 'M' || kind === 'T') repo.write(fixture);
      repo.commit();
      if (kind === 'R') {
        mkdirSync(path.dirname(path.join(repo.dir, fixture)), { recursive: true });
        repo.git('mv', 'src/source.ts', fixture);
      } else if (kind === 'T') {
        repo.remove(fixture);
        symlinkSync('missing-target', path.join(repo.dir, fixture));
      } else {
        repo.write(fixture, 'export const fixture = 2;\n');
      }
      repo.git('add', fixture);
      repo.remove(fixture);
      const cached = repo.git('diff', '--cached', '--name-status', '-z');
      assert.ok(cached.startsWith(kind), cached);
      assert.ok(repo.git('ls-files', '-z').split('\0').includes(fixture), 'the fixture is still in the index');
      const result = repo.check();
      assert.equal(result.status, 1, `index ${kind} must not be treated as a deletion`);
      assert.ok(result.logs[0].includes(fixture));
      assert.deepEqual(result.checks, [], 'refuse before running validators');
      repo.git('reset', '-q', 'HEAD', '--', fixture);
      assert.equal(repo.check().status, 0, 'unstaging the fixture permits a retry');
    });
  }
});

test('a genuine staged fixture deletion is allowed even when the working file is recreated', (t) => {
  const repo = repository(t);
  const fixture = 'src/.lint-fixture-delete/x.ts';
  repo.write(fixture);
  repo.commit();
  repo.git('rm', fixture);
  repo.write(fixture);
  assert.equal(repo.git('diff', '--cached', '--name-status', '-z'), `D\0${fixture}\0`);
  const result = repo.check();
  assert.equal(result.status, 0);
  assert.deepEqual(result.logs, []);
  assert.ok(result.checks.includes('node scripts/file-size.mjs --staged'), 'deletions still plan source checks');
  assert.ok(result.checks.includes('node scripts/precommit.mjs --typecheck-index'), 'the recreated file is an unstaged typed file');
});

test('an actual copied fixture is rejected after working-tree cleanup', (t) => {
  const repo = repository(t);
  const fixture = 'src/.lint-fixture-copy/x.ts';
  const source = 'export const fixture = 1;\n'.repeat(30);
  repo.write('src/source.ts', source);
  repo.commit();
  repo.git('config', 'diff.renames', 'copies');
  repo.write(fixture, source);
  repo.write('src/source.ts', `${source}// source changed\n`);
  repo.git('add', '.');
  repo.remove(fixture);
  assert.ok(repo.git('diff', '--cached', '--name-status', '-z').includes(`C100\0src/source.ts\0${fixture}\0`));
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.deepEqual(result.checks, []);
});

test('rename destinations determine fixture admission with rename detection enabled or disabled', async (t) => {
  for (const detect of ['true', 'false']) {
    for (const intoFixture of [false, true]) {
      await t.test(`renames=${detect}, destination fixture=${intoFixture}`, (t) => {
        const repo = repository(t);
        const source = 'src/.lint-fixture-before/x.ts';
        const destination = intoFixture ? 'src/.lint-fixture-after/y.ts' : 'src/real source.ts';
        repo.write(source);
        repo.commit();
        repo.git('config', 'diff.renames', detect);
        mkdirSync(path.dirname(path.join(repo.dir, destination)), { recursive: true });
        repo.git('mv', source, destination);
        repo.remove(destination);
        assert.equal(repo.check().status, intoFixture ? 1 : 0);
      });
    }
  }
});

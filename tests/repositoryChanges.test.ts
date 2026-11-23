import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(s, c, next) {
    try {
      return next(s, c);
    } catch (e) {
      if (s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c);
      throw e;
    }
  },
});
const { repositoryDiffFiles: readDiffFiles } = await import('../src/lib/repositoryChanges.ts');
const patch = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n old\n+new\n`;
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const base = 'a'.repeat(40);
const localBase = 'b'.repeat(40);

function repositoryDiffFiles(git: Parameters<typeof readDiffFiles>[0], cwd: string, scope: 'branch' | 'uncommitted', fresh = false) {
  return readDiffFiles(
    {
      ...git,
      run: (dir, [flag, ...args]) => {
        assert.equal(flag, '--no-lazy-fetch');
        return git.run(dir, args);
      },
    },
    cwd,
    scope,
    fresh,
  );
}

test('branch totals include committed changes and untracked work, using merge-base rather than HEAD~1', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      return ok(
        args[0] === 'symbolic-ref' ? 'refs/remotes/origin/trunk\n' : args[0] === 'merge-base' ? `${base}\n` : patch('committed.txt'),
      );
    },
    status: async () => ({
      files: [
        { code: ' M', path: 'committed.txt' },
        { code: '??', path: 'new.txt' },
      ],
    }),
    diff: async (_cwd: string, file?: string) => {
      assert.equal(file, 'new.txt');
      return patch(file!);
    },
  };
  const files = await repositoryDiffFiles(git, '/repo', 'branch');
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed]),
    [
      ['committed.txt', 1, 0],
      ['new.txt', 1, 0],
    ],
  );
  assert.deepEqual(calls[1], ['merge-base', 'HEAD', 'refs/remotes/origin/trunk']);
  assert.deepEqual(calls[2], [
    'diff',
    base,
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
  ]);
});

test('a repository without fetched remote defaults uses local main when available, otherwise HEAD', async () => {
  for (const hasMain of [true, false]) {
    const calls: string[][] = [];
    const files = await repositoryDiffFiles(
      {
        run: async (_cwd, args) => {
          calls.push(args);
          if (args[0] === 'for-each-ref' || args[0] === 'remote') return ok();
          return args[0] === 'diff'
            ? ok(patch('pending.txt'))
            : args[0] === 'merge-base' && args[2] === 'refs/heads/main' && hasMain
              ? ok(localBase)
              : { ok: false, stdout: '', stderr: 'missing ref' };
        },
        status: async () => ({ files: [] }),
        diff: async () => '',
      },
      '/repo',
      'branch',
    );
    assert.equal(files[0].added, 1);
    assert.equal(calls.at(-1)![1], hasMain ? localBase : 'HEAD');
  }
});

test('failed branch reads propagate and uncommitted retains its separate scope', async () => {
  const git = {
    run: async (_cwd: string, args: string[]) =>
      args[0] === 'for-each-ref' || args[0] === 'remote' ? ok() : { ok: false, stdout: '', stderr: 'repository unavailable' },
    status: async () => ({ files: [] }),
    diff: async () => patch('pending.txt'),
  };
  await assert.rejects(repositoryDiffFiles(git, '/repo', 'branch'), /repository unavailable/);
  assert.equal((await repositoryDiffFiles(git, '/repo', 'uncommitted'))[0].path, 'pending.txt');
});

test('empty folder, empty base, and unavailable status are handled without invented changes', async () => {
  let calls = 0;
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls++;
      return ok(args[0] === 'diff' ? patch('x.txt') : '');
    },
    status: async () => null,
    diff: async () => '',
  };
  assert.deepEqual(await repositoryDiffFiles(git, '', 'branch'), []);
  assert.equal(calls, 0);
  await assert.rejects(repositoryDiffFiles(git, '/repo', 'branch'), /repository status/);
  const noMessage = {
    ...git,
    run: async (_cwd: string, args: string[]) =>
      args[0] === 'for-each-ref' || args[0] === 'remote' ? ok() : { ok: false, stdout: '', stderr: '' },
  };
  await assert.rejects(repositoryDiffFiles(noMessage, '/repo', 'branch'), /Could not read branch changes/);
});

test('branch reads remain repository-wide when the user configures relative diffs', async () => {
  const files = await repositoryDiffFiles(
    {
      run: async (_cwd, args) =>
        args[0] === 'for-each-ref' || args[0] === 'remote'
          ? ok()
          : args[0] === 'diff'
            ? ok(args.includes('--no-relative') ? patch('outside.txt') : '')
            : { ok: false, stdout: '', stderr: 'no upstream' },
      status: async () => ({ files: [] }),
      diff: async () => '',
    },
    '/repo/sub',
    'branch',
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['outside.txt'],
  );
});

test('explicit freshness reaches uncommitted diffs and branch status/untracked reads', async () => {
  const reads: any[] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => ok(args[0] === 'merge-base' ? base : ''),
    status: async (_cwd: string, fresh?: boolean) => {
      reads.push(['status', fresh]);
      return { files: [{ code: '??', path: 'new.txt' }] };
    },
    diff: async (_cwd: string, file?: string, fresh?: boolean) => {
      reads.push(['diff', file, fresh]);
      return patch(file ?? 'pending.txt');
    },
  };
  await repositoryDiffFiles(git, '/repo', 'uncommitted', true);
  await repositoryDiffFiles(git, '/repo', 'branch', true);
  assert.deepEqual(reads, [
    ['diff', undefined, true],
    ['status', true],
    ['diff', 'new.txt', true],
  ]);
});

test('branch changes before the first commit include staged working files and untracked files', async () => {
  const calls: string[][] = [];
  const files = await repositoryDiffFiles(
    {
      run: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === 'for-each-ref' || args[0] === 'remote') return ok();
        if (args[0] === 'symbolic-ref' && args[2] === 'HEAD') return ok('refs/heads/main\n');
        if (args[0] === 'show-ref') return { ok: false, code: 1, stdout: '', stderr: '' };
        if (args[0] === 'hash-object') return ok('empty-tree');
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n');
        if (args[0] === 'diff' && args[1] === 'empty-tree') return ok(patch('staged.txt'));
        return { ok: false, stdout: '', stderr: 'HEAD does not exist' };
      },
      status: async () => ({
        files: [
          { code: 'AM', path: 'staged.txt' },
          { code: '??', path: 'untracked.txt' },
        ],
      }),
      diff: async (_cwd, file) => {
        assert.equal(file, 'untracked.txt');
        return patch(file!);
      },
    },
    '/new-repo',
    'branch',
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['staged.txt', 'untracked.txt'],
  );
  assert.ok(calls.some((args) => args.join(' ') === 'hash-object -w -t tree -- /dev/null'));
});

test('failed reads do not treat existing HEADs or non-worktrees as empty repositories', async () => {
  for (const scenario of ['existing-head', 'not-worktree', 'bare', 'failed-empty', 'blank-empty', 'failed-diff']) {
    const calls: string[][] = [];
    const error = { ok: false, stdout: '', stderr: 'read failed' };
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'for-each-ref' || args[0] === 'remote') return ok();
        if (args[0] === 'rev-parse' && args[1] === '--verify') return scenario === 'existing-head' ? ok('commit') : error;
        if (args[0] === 'rev-parse') return scenario === 'not-worktree' ? error : ok(scenario === 'bare' ? 'false' : 'true');
        if (args[0] === 'symbolic-ref' && args[2] === 'HEAD') return ok('refs/heads/main\n');
        if (args[0] === 'show-ref') return { ok: false, code: 1, stdout: '', stderr: '' };
        if (args[0] === 'hash-object') return scenario === 'failed-empty' ? error : ok(scenario === 'blank-empty' ? '' : 'empty-tree');
        return error;
      },
      status: async () => ({ files: [] }),
      diff: async () => '',
    };
    await assert.rejects(
      repositoryDiffFiles(git, '/repo', 'branch'),
      scenario === 'blank-empty' ? /Could not read empty repository tree/ : /read failed/,
    );
    if (['existing-head', 'not-worktree', 'bare'].includes(scenario)) assert.ok(!calls.some((args) => args[0] === 'hash-object'));
  }
});

test('a broken HEAD is reported instead of showing all branch files as new', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'for-each-ref' || args[0] === 'remote') return ok();
      if (args[1] === '--is-inside-work-tree') return ok('true');
      if (args[0] === 'hash-object') return ok('empty-tree');
      if (args[0] === 'diff' && args[1] === 'empty-tree') return ok(patch('existing.txt'));
      return { ok: false, stdout: '', stderr: 'broken HEAD' };
    },
    status: async () => ({ files: [] }),
    diff: async () => '',
  };
  await assert.rejects(repositoryDiffFiles(git, '/repo', 'branch'), /broken HEAD/);
  assert.ok(!calls.some((args) => args[0] === 'hash-object'));
});

// Index-aware discard and restoration with mocked Git, including failures and unborn branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discardGitChanges, discardGitFile, restoreFromRoot } from '../src/lib/gitDiscard.ts';
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0 });
const fail = (code = 128) => ({ ok: false, stdout: '', stderr: 'read failed', code });

const withRoot = (git: { run(cwd: string, args: string[]): Promise<any> }) => ({
  run: (cwd: string, args: string[]) =>
    args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? Promise.resolve(ok('/repo\n')) : git.run(cwd, args),
});

test('tracked files and staged additions restore both the index and working tree, with literal paths', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (cwd: string, args: string[]) => {
      assert.equal(cwd, '/repo');
      calls.push(args);
      return ok('commit');
    },
  };
  assert.equal((await discardGitFile(withRoot(git), '/repo', 'new[1]*.txt')).ok, true);
  assert.deepEqual(calls, [
    ['ls-files', '--error-unmatch', '--', ':(literal)new[1]*.txt'],
    ['diff', '--cached', '--name-status', '--find-renames', '-z'],
    ['rev-parse', '--verify', 'HEAD'],
    ['restore', '--source=HEAD', '--staged', '--worktree', '--', ':(literal)new[1]*.txt'],
  ]);
});

test('untracked files use clean, while index lookup errors stop without deleting files', async () => {
  for (const code of [1, 128]) {
    const calls: string[][] = [];
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        return args[0] === 'ls-files' ? fail(code) : ok();
      },
    };
    assert.equal((await discardGitFile(withRoot(git), '/repo', 'new.txt')).ok, code === 1);
    assert.equal(calls.length, code === 1 ? 3 : 1);
    if (code === 1) assert.deepEqual(calls[2], ['clean', '-f', '--', ':(literal)new.txt']);
  }
});

test('unborn repositories restore staged additions against the empty tree', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--verify') return fail();
      if (args[1] === '--is-inside-work-tree') return ok('true\n');
      if (args[0] === 'symbolic-ref') return ok('refs/heads/main\n');
      if (args[0] === 'show-ref') return fail(1);
      if (args[0] === 'ls-files') return ok('staged.txt\0');
      if (args[0] === 'hash-object') return ok('empty-tree\n');
      return ok();
    },
  };
  assert.equal((await restoreFromRoot(git, '/repo', ['.'])).ok, true);
  assert.deepEqual(calls.at(-1), ['restore', '--source=empty-tree', '--staged', '--worktree', '--', '.']);
});

test('source resolution failures never run restore', async () => {
  for (const mode of ['outside', 'bare', 'hash-error', 'hash-empty']) {
    const calls: string[][] = [];
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--verify') return fail();
        if (args[1] === '--is-inside-work-tree') return mode === 'outside' ? fail() : ok(mode === 'bare' ? 'false' : 'true');
        if (args[0] === 'symbolic-ref') return ok('refs/heads/main\n');
        if (args[0] === 'show-ref') return fail(1);
        return mode === 'hash-error' ? fail() : ok();
      },
    };
    assert.equal((await restoreFromRoot(git, '/repo', ['.'])).ok, false);
    assert.ok(!calls.some((args) => args[0] === 'restore'));
  }
});

test('staged deletions restore the file from HEAD instead of treating it as untracked', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'ls-files') return fail(1);
      if (args[0] === 'diff') return ok('gone[1].txt\0');
      return ok();
    },
  };
  assert.equal((await discardGitFile(withRoot(git), '/repo', 'gone[1].txt')).ok, true);
  assert.deepEqual(calls.at(-1), ['restore', '--source=HEAD', '--staged', '--worktree', '--', ':(literal)gone[1].txt']);
  assert.ok(!calls.some((args) => args[0] === 'clean'));
});

test('a staged deletion lookup failure stops discard without cleaning the file', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'ls-files' ? fail(1) : fail();
    },
  };
  assert.equal((await discardGitFile(withRoot(git), '/repo', 'gone.txt')).ok, false);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['ls-files', 'diff'],
  );
});

test('staged rename discard restores both names, while copies and other renames leave their source alone', async () => {
  for (const [status, paths] of [
    ['R100\0old[1].txt\0new.txt\0', ['old[1].txt', 'new.txt']],
    ['M\0new.txt\0', ['new.txt']],
    ['C100\0old.txt\0new.txt\0', ['new.txt']],
    ['R100\0other.txt\0elsewhere.txt\0', ['new.txt']],
  ] as const) {
    const calls: string[][] = [];
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        return ok(args[0] === 'diff' ? status : '');
      },
    };
    assert.equal((await discardGitFile(withRoot(git), '/repo', 'new.txt')).ok, true);
    assert.deepEqual(calls.at(-1), [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...paths.map((path) => `:(literal)${path}`),
    ]);
  }
});

test('rename lookup errors stop discard before modifying the index or working tree', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'diff' ? fail() : ok();
    },
  };
  assert.equal((await discardGitFile(withRoot(git), '/repo', 'new.txt')).ok, false);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['ls-files', 'diff'],
  );
});

test('failed HEAD resolution requires a confirmed unborn branch before restoring an empty tree', async () => {
  for (const mode of ['symbolic-error', 'symbolic-empty', 'ref-present', 'ref-error', 'ref-missing']) {
    const calls: string[][] = [];
    const headFailure = fail();
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[1] === '--verify' && args[0] === 'rev-parse') return headFailure;
        if (args[1] === '--is-inside-work-tree') return ok('true');
        if (args[0] === 'symbolic-ref')
          return mode === 'symbolic-error' ? fail() : ok(mode === 'symbolic-empty' ? '' : 'refs/heads/main\n');
        if (args[0] === 'show-ref') {
          assert.deepEqual(args, ['show-ref', '--verify', '--quiet', 'refs/heads/main']);
          return mode === 'ref-present' ? ok('commit') : fail(mode === 'ref-missing' ? 1 : 128);
        }
        return ok('empty-tree');
      },
    };
    const result = await restoreFromRoot(git, '/repo', ['kept.txt']);
    if (mode === 'ref-missing') {
      assert.equal(result.ok, true);
      assert.deepEqual(calls.at(-1), ['restore', '--source=empty-tree', '--staged', '--worktree', '--', 'kept.txt']);
    } else {
      assert.equal(result, headFailure);
      assert.ok(!calls.some((args) => ['hash-object', 'restore', 'clean'].includes(args[0])));
    }
  }
});

test('bulk restoration skips an empty tracked scope but propagates index and tree read failures', async () => {
  for (const mode of ['empty', 'unborn', 'tree-tracked', 'index-error', 'tree-error']) {
    const calls: string[][] = [];
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--verify') return mode === 'unborn' ? fail() : ok('commit');
        if (args[0] === 'rev-parse') return ok('true');
        if (args[0] === 'symbolic-ref') return ok('refs/heads/main');
        if (args[0] === 'show-ref') return fail(1);
        if (args[0] === 'hash-object') return ok('empty-tree');
        if (args[0] === 'ls-files') return mode === 'index-error' ? fail() : ok();
        if (args[0] === 'ls-tree') return mode === 'tree-error' ? fail() : ok(mode === 'tree-tracked' ? 'deleted.txt\0' : '');
        if (args[0] === 'restore') return fail(1);
        return ok('commit');
      },
    };
    const result = await restoreFromRoot(git, '/repo', ['.']);
    assert.equal(result.ok, ['empty', 'unborn'].includes(mode));
    assert.equal(
      calls.some((args) => args[0] === 'restore'),
      mode === 'tree-tracked',
    );
    if (['empty', 'unborn'].includes(mode))
      assert.deepEqual(calls.slice(-2), [
        ['ls-files', '-z', '--', '.'],
        ['ls-tree', '-r', '--name-only', '-z', mode === 'unborn' ? 'empty-tree' : 'HEAD', '--', '.'],
      ]);
  }
});

test('bulk restoration still restores indexed paths and multi-path requests', async () => {
  for (const paths of [['.'], ['first.txt', 'second.txt']]) {
    const calls: string[][] = [];
    const git = {
      run: async (_cwd: string, args: string[]) => {
        calls.push(args);
        return ok('tracked.txt\0');
      },
    };
    assert.equal((await restoreFromRoot(git, '/repo', paths)).ok, true);
    assert.deepEqual(calls.at(-1), ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
    assert.ok(!calls.some((args) => args[0] === 'ls-tree'));
  }
});

for (const operation of ['discard', 'discard all']) {
  test(`${operation} resolves the exact repository root before modifying a selected file`, async () => {
    const calls: { cwd: string; args: string[] }[] = [];
    const git = {
      run: async (cwd: string, args: string[]) => {
        calls.push({ cwd, args });
        return ok(args[1] === '--show-toplevel' ? '/repo \n' : args[0] === 'ls-files' ? 'tracked.txt\0' : '');
      },
    };
    const result =
      operation === 'discard' ? await discardGitFile(git, '/repo /sub', 'outside[1].txt') : await discardGitChanges(git, '/repo /sub');
    assert.equal(result.ok, true);
    assert.equal(calls[0].cwd, '/repo /sub');
    assert.deepEqual(calls[0].args, ['rev-parse', '--show-toplevel']);
    assert.ok(calls.slice(1).every((call) => call.cwd === '/repo '));
    assert.ok(calls.some((call) => call.args[0] === 'restore'));
  });
  test(`${operation} stops when its repository root is unavailable`, async () => {
    for (const result of [fail(), ok('')]) {
      const calls: string[][] = [];
      const git = {
        run: async (_cwd: string, args: string[]) => {
          calls.push(args);
          return result;
        },
      };
      const outcome = operation === 'discard' ? await discardGitFile(git, '/repo', 'x') : await discardGitChanges(git, '/repo');
      assert.equal(outcome.ok, false);
      assert.ok(outcome.stderr);
      assert.deepEqual(calls, [['rev-parse', '--show-toplevel']]);
    }
  });
}

test('bulk discard restores tracked files before cleaning from the exact root and stops on failures', async () => {
  for (const mode of ['success', 'root-error', 'restore-message', 'restore-empty', 'clean-message', 'clean-empty']) {
    const calls: { cwd: string; args: string[] }[] = [];
    const git = {
      run: async (cwd: string, args: string[]) => {
        calls.push({ cwd, args });
        if (args[1] === '--show-toplevel') return mode === 'root-error' ? fail() : ok('/repo \n');
        if (args[0] === 'ls-files') return ok('tracked.txt\0');
        if ((args[0] === 'restore' && mode.startsWith('restore-')) || (args[0] === 'clean' && mode.startsWith('clean-')))
          return { ...fail(), stderr: mode.endsWith('message') ? 'operation failed' : '' };
        return ok('commit');
      },
    };
    const result = await discardGitChanges(git, '/repo /sub');
    assert.equal(result.ok, mode === 'success');
    if (!result.ok) assert.ok(result.stderr);
    assert.ok(calls.slice(1).every((call) => call.cwd === '/repo '));
    assert.equal(
      calls.some((call) => call.args[0] === 'clean'),
      ['success', 'clean-message', 'clean-empty'].includes(mode),
    );
    if (mode === 'success')
      assert.deepEqual(
        calls.slice(-2).map((call) => call.args),
        [
          ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'],
          ['clean', '-fd', '--', '.'],
        ],
      );
  }
});

test('a scope keeps a bulk discard to that folder: its tracked files restored, its untracked files cleaned, nothing restored when none is tracked', async () => {
  const calls: string[][] = [];
  const git = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[1] === '--show-toplevel') return ok('/repo\n');
      if (args[0] === 'ls-files') return ok('sub/tracked.txt\0');
      return ok('commit');
    },
  };
  assert.equal((await discardGitChanges(git, '/repo/sub', 'sub/')).ok, true);
  assert.deepEqual(calls.slice(-2), [
    ['restore', '--source=HEAD', '--staged', '--worktree', '--', ':(literal)sub/'],
    ['clean', '-fd', '--', ':(literal)sub/'],
  ]);
  calls.length = 0;
  const untrackedOnly = {
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[1] === '--show-toplevel') return ok('/repo\n');
      return ok(args[0] === 'ls-files' || args[0] === 'ls-tree' ? '' : 'commit');
    },
  };
  assert.equal((await discardGitChanges(untrackedOnly, '/repo/sub', 'sub/')).ok, true);
  assert.equal(
    calls.some((args) => args[0] === 'restore'),
    false,
    'nothing tracked in the folder: nothing to restore',
  );
  assert.deepEqual(calls.at(-1), ['clean', '-fd', '--', ':(literal)sub/']);
});

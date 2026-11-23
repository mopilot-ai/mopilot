// Checked Git working-tree diffs and repository-relative file selection with mocked commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseUnifiedDiff } from '../src/lib/diff.ts';
const { createGitDiff } = createRequire(import.meta.url)('../electron/platform/gitDiff.cjs');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const failed = (stderr = '', code = 128) => ({ ok: false, code, stdout: '', stderr });

test('tracked and untracked patch reads force stable paths and disable text conversions', async () => {
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/repo');
    if (args[0] === 'ls-files') return ok('new.txt\0');
    for (const flag of ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'])
      assert.ok(args.includes(flag));
    return ok(args[1] === '--no-index' ? '' : 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n');
  });
  assert.equal(parseUnifiedDiff(await read('/repo'))[0].path, 'empty.txt');
});

test('selected tracked filenames use literal matching rather than Git wildcard syntax', async () => {
  for (const file of ['file*.txt', '[ab].txt', ':(glob)*']) {
    const read = createGitDiff(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return ok('/repo');
      if (args[0] === 'ls-files') return ok();
      return ok(args.at(-1) === `:(literal)${file}` ? 'selected file only' : 'matched siblings');
    });
    assert.equal(await read('/repo', file), 'selected file only');
  }
});

test('repository roots with trailing whitespace are passed verbatim to diff commands', async () => {
  const read = createGitDiff(async (_cmd: string, args: string[], options: { cwd: string }) => {
    if (args[0] === 'rev-parse') return ok('/repo \n');
    assert.equal(options.cwd, '/repo ');
    return ok();
  });
  assert.equal(await read('/repo /sub'), '');
});

test('a subfolder reads the whole repository and selects files by repository-relative path', async () => {
  for (const file of [undefined, 'sub/inside.txt', 'outside.txt']) {
    const calls: { args: string[]; cwd: string }[] = [];
    const read = createGitDiff(async (_cmd: string, args: string[], options: { cwd: string }) => {
      calls.push({ args, cwd: options.cwd });
      if (args[0] === 'rev-parse') return ok('/repo\n');
      if (args[0] === 'ls-files') return ok(options.cwd === '/repo' ? 'outside.txt\0sub/inside.txt\0' : 'inside.txt\0');
      if (args[1] === '--no-index') return { ...failed('', 1), stdout: args.at(-1) + '\n' };
      return ok();
    });
    assert.equal(await read('/repo/sub', file), file ? file + '\n' : 'outside.txt\nsub/inside.txt\n');
    assert.deepEqual(calls[0], { args: ['rev-parse', '--show-toplevel'], cwd: '/repo/sub' });
    assert.ok(calls.slice(1).every((call) => call.cwd === '/repo'));
  }
});

test('working diffs include untracked names verbatim and respect the selected file', async () => {
  for (const file of [undefined, 'tab\t你好.txt']) {
    const calls: string[][] = [];
    const read = createGitDiff(async (cmd: string, args: string[], options: { cwd: string }) => {
      assert.equal(cmd, 'git');
      assert.equal(options.cwd, '/repo');
      calls.push(args);
      if (args[0] === 'rev-parse') return ok('/repo');
      if (args[0] === 'ls-files') return ok('other.txt\0tab\t你好.txt\0');
      if (args[1] === '--no-index') return { ...failed('', 1), stdout: args.at(-1) + '\n' };
      return ok('tracked\n');
    });
    assert.equal(await read('/repo', file), file ? 'tracked\ntab\t你好.txt\n' : 'tracked\nother.txt\ntab\t你好.txt\n');
    assert.deepEqual(calls[1], [
      'diff',
      'HEAD',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      ...(file ? ['--', `:(literal)${file}`] : []),
    ]);
  }
  const empty = createGitDiff(async (_cmd: string, args: string[]) => ok(args[0] === 'rev-parse' ? '/repo' : ''));
  assert.equal(await empty('/repo'), '');
});

test('unborn HEAD reads staged working changes against the empty tree', async () => {
  const calls: string[][] = [];
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo');
    if (args[0] === 'symbolic-ref') return ok('refs/heads/main\n');
    if (args[0] === 'show-ref') return failed('', 1);
    if (args[0] === 'hash-object') return ok('empty-tree\n');
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return ok('true\n');
    if (args[0] === 'ls-files') return ok();
    if (args[0] === 'diff' && args[1] === 'empty-tree') return ok('staged and unstaged\n');
    return failed('no HEAD');
  });
  assert.equal(await read('/repo', 'new.txt'), 'staged and unstaged\n');
  assert.deepEqual(calls.at(-2), [
    'diff',
    'empty-tree',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--',
    ':(literal)new.txt',
  ]);
});

test('failed Git commands throw, including failures after a successful tracked diff', async () => {
  for (const mode of ['head', 'outside', 'bare', 'tree-error', 'tree-empty', 'retry', 'listing', 'file']) {
    for (const message of ['', 'permission denied']) {
      const read = createGitDiff(async (_cmd: string, args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo');
        if (args[0] === 'diff' && args[1] === 'HEAD') return ['listing', 'file'].includes(mode) ? ok('tracked') : failed(message);
        if (args[0] === 'rev-parse' && args[1] === '--verify') return mode === 'head' ? ok('commit') : failed();
        if (args[0] === 'rev-parse') return mode === 'outside' ? failed() : ok(mode === 'bare' ? 'false' : 'true');
        if (args[0] === 'symbolic-ref') return ok('refs/heads/main\n');
        if (args[0] === 'show-ref') return failed('', 1);
        if (args[0] === 'hash-object') return mode === 'tree-error' ? failed(message) : ok(mode === 'tree-empty' ? '' : 'empty-tree');
        if (args[0] === 'ls-files') return mode === 'listing' ? failed(message) : ok('new.txt\0');
        return failed(message);
      });
      await assert.rejects(read('/repo'), message && mode !== 'tree-empty' ? /permission denied/ : /Could not read/);
    }
  }
  const unchanged = createGitDiff(async (_cmd: string, args: string[]) =>
    args[0] === 'ls-files' ? ok('empty.txt\0') : ok(args[0] === 'rev-parse' ? '/repo' : ''),
  );
  assert.equal(await unchanged('/repo'), '');
});

test('failed or empty root lookups are reported before reading any diff', async () => {
  for (const output of [failed('root unavailable'), failed(), ok('')]) {
    const calls: string[][] = [];
    const read = createGitDiff(async (_cmd: string, args: string[]) => {
      calls.push(args);
      return output;
    });
    await assert.rejects(read('/repo/sub'), output.stderr ? /root unavailable/ : /Could not read repository root/);
    assert.deepEqual(calls, [['rev-parse', '--show-toplevel']]);
  }
});

test('a no-index exit code 1 with no patch is an error, not a successful empty diff', async () => {
  for (const message of ['Could not access file', '']) {
    const read = createGitDiff(async (_cmd: string, args: string[]) =>
      args[0] === 'rev-parse'
        ? ok('/repo')
        : args[0] === 'ls-files'
          ? ok('missing\0')
          : args[1] === '--no-index'
            ? failed(message, 1)
            : ok(),
    );
    await assert.rejects(read('/repo'), message ? /Could not access file/ : /Could not read untracked file changes/);
  }
});

test('a broken HEAD does not turn tracked diff failures into added files', async () => {
  const calls: string[][] = [];
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === '--show-toplevel') return ok('/repo');
    if (args[1] === '--is-inside-work-tree') return ok('true');
    if (args[0] === 'hash-object') return ok('empty-tree');
    if (args[0] === 'diff' && args[1] === 'empty-tree') return ok('invented additions');
    if (args[0] === 'ls-files') return ok();
    return failed('broken HEAD');
  });
  await assert.rejects(read('/repo'), /broken HEAD/);
  assert.ok(!calls.some((args) => args[0] === 'hash-object'));
});

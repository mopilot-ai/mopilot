import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGitQueries } = require('../electron/platform/gitQueries.cjs');

test('Git queries reject unavailable folders and repositories without spawning further commands', async () => {
  const none = createGitQueries({
    run: async () => {
      assert.fail('no subprocess expected');
    },
    fs: { existsSync: () => false },
  });
  for (const cwd of [null, '/missing']) {
    assert.equal(await none.gitInfo(cwd), null);
    assert.equal(await none.gitStatus(cwd), null);
  }
  const failed = createGitQueries({ run: async () => ({ ok: false }), fs: { existsSync: () => true } });
  assert.equal(await failed.gitInfo('/repo'), null);
  assert.equal(await failed.gitStatus('/repo'), null);
  const defaults = createGitQueries({
    run: async () => {
      assert.fail('missing folder');
    },
  });
  assert.equal(await defaults.gitInfo('/this-folder-does-not-exist-mopilot-quality'), null);
});

test('Git queries return repository identity and verbatim paths with tracked and untracked line counts', async () => {
  const outputs = new Map([
    ['rev-parse --show-toplevel', '/repo\n'],
    ['symbolic-ref --quiet --short HEAD', ' main\n'],
    ['config --get remote.origin.url', ' git@example.test:repo\n'],
    ['branch --format=%(refname:short)', 'main\n work \n\n'],
    ['status --porcelain=v1 -uall -z', ' M tracked.ts\0?? new.ts\0?? no-newline.ts\0 M unstatted\0'],
    ['diff HEAD --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ --numstat -z', '2\t1\ttracked.ts\0'],
  ]);
  const queries = createGitQueries({
    run: async (cmd: string, args: string[], options: { cwd: string }) => {
      assert.equal(cmd, 'git');
      assert.equal(options.cwd, '/repo');
      if (args[1] === '--no-index') return { ok: false, code: 1, stdout: `2\t0\t\0/dev/null\0${args.at(-1)}\0` };
      return { ok: true, stdout: outputs.get(args.join(' ')) };
    },
    fs: {
      existsSync: () => true,
      readFileSync: (file: string) => {
        if (file.endsWith('unreadable')) throw new Error('unreadable');
        return file.endsWith('new.ts') ? 'one\ntwo\n' : 'one\ntwo';
      },
    },
  });
  assert.deepEqual(await queries.gitInfo('/repo'), {
    root: '/repo',
    branch: 'main',
    remote: 'git@example.test:repo',
    branches: ['main', 'work'],
  });
  assert.deepEqual(await queries.gitStatus('/repo'), {
    files: [
      { code: ' M', path: 'tracked.ts', added: 2, removed: 1 },
      { code: '??', path: 'new.ts', added: 2, removed: 0 },
      { code: '??', path: 'no-newline.ts', added: 2, removed: 0 },
      { code: ' M', path: 'unstatted', added: 0, removed: 0 },
    ],
  });
});

test('repository info preserves whitespace in root paths and rejects empty successful output', async () => {
  for (const root of ['/repo ', '/repo\t', '/repo\n', '/repo\r']) {
    const queries = createGitQueries({
      fs: { existsSync: () => true },
      run: async (_cmd: string, args: string[]) => ({ ok: true, stdout: args[1] === '--show-toplevel' ? root + '\n' : 'main\n' }),
    });
    assert.equal((await queries.gitInfo(root)).root, root);
  }
  let calls = 0;
  const queries = createGitQueries({
    fs: { existsSync: () => true },
    run: async () => {
      calls++;
      return { ok: true, stdout: '\n' };
    },
  });
  assert.equal(await queries.gitInfo('/repo'), null);
  assert.equal(calls, 1);
});

test('an unborn repository reports its symbolic branch name rather than HEAD', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'feature\n' };
      if (args[1] === '--abbrev-ref') return { ok: false, stdout: 'HEAD\n', stderr: 'unknown revision' };
      return { ok: true, stdout: args[1] === '--show-toplevel' ? '/repo\n' : '' };
    },
    fs: { existsSync: () => true },
  });
  assert.equal((await queries.gitInfo('/repo')).branch, 'feature');
});

test('detached HEAD is verified and branch-read failures remain unavailable', async () => {
  for (const scenario of ['detached', 'invalid-head', 'permission', 'missing-command', 'empty-branch']) {
    const calls: string[][] = [];
    const queries = createGitQueries({
      run: async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'symbolic-ref')
          return {
            ok: scenario === 'empty-branch',
            stdout: '',
            code: scenario === 'permission' ? 128 : scenario === 'missing-command' ? 'ENOENT' : 1,
          };
        if (args[1] === '--verify') return { ok: scenario === 'detached', stdout: 'commit' };
        return { ok: true, stdout: args[1] === '--show-toplevel' ? '/repo\n' : '' };
      },
      fs: { existsSync: () => true },
    });
    const info = await queries.gitInfo('/repo');
    if (scenario === 'detached') assert.equal(info.branch, 'HEAD');
    else assert.equal(info, null);
    if (['permission', 'missing-command', 'empty-branch'].includes(scenario)) assert.equal(calls.length, 2);
  }
});

test('repository metadata and untracked totals preserve trailing whitespace in the root path', async () => {
  const roots: string[] = [];
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[], options: { cwd: string }) => {
      if (args[1] === '--no-index') {
        roots.push(options.cwd);
        return { ok: false, code: 1, stdout: '1\t0\t\0/dev/null\0file.txt\0' };
      }
      return {
        ok: true,
        stdout:
          args[1] === '--show-toplevel' ? '/repo \n' : args[0] === 'symbolic-ref' ? 'main\n' : args[0] === 'status' ? '?? file.txt\0' : '',
      };
    },
    fs: { existsSync: () => true },
  });
  assert.equal((await queries.gitInfo('/repo /sub')).root, '/repo ');
  assert.equal((await queries.gitStatus('/repo /sub')).files[0].added, 1);
  assert.deepEqual(roots, ['/repo ']);
});

test('successful root commands with empty output do not produce repository metadata', async () => {
  const queries = createGitQueries({ run: async () => ({ ok: true, stdout: '' }), fs: { existsSync: () => true } });
  assert.equal(await queries.gitInfo('/repo'), null);
});

test('status rows in an unmerged state carry conflicted, and only those', async () => {
  const codes = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU', ' M', 'M ', 'A ', 'MM'];
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => ({
      ok: true,
      stdout: args[0] === 'status' ? codes.map((code, i) => `${code} f${i}.txt\0`).join('') : '',
    }),
    fs: { existsSync: () => true },
  });
  const rows = (await queries.gitStatus('/repo')).files;
  assert.deepEqual(
    rows.map((f: any) => [f.code, f.conflicted === true]),
    codes.map((code) => [code, ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)]),
  );
});

test('status line counts ignore relative diff settings when opened from a subfolder', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => ({
      ok: true,
      stdout:
        args[0] === 'status'
          ? ' M outside.txt\0 M sub/inside.txt\0'
          : args.includes('--no-relative')
            ? '1\t0\toutside.txt\0' + '1\t0\tsub/inside.txt\0'
            : '',
    }),
    fs: { existsSync: () => true },
  });
  assert.deepEqual(
    (await queries.gitStatus('/repo/sub')).files.map((file: any) => [file.path, file.added]),
    [
      ['outside.txt', 1],
      ['sub/inside.txt', 1],
    ],
  );
});

test('untracked symlink and attribute-defined binary counts come from Git, not target contents', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') return { ok: true, stdout: '?? link\0?? attribute.bin\0' };
      if (args[0] === 'rev-parse') return { ok: true, stdout: '/repo\n' };
      if (args[1] === '--no-index')
        return { ok: false, code: 1, stdout: args.at(-1) === 'link' ? '1\t0\t\0/dev/null\0link\0' : '-\t-\t\0/dev/null\0attribute.bin\0' };
      return { ok: true, stdout: '' };
    },
    fs: { existsSync: () => true, readFileSync: () => 'alpha\nbeta\n' },
  });
  assert.deepEqual(
    (await queries.gitStatus('/repo')).files.map((file: any) => [file.path, file.added, file.removed]),
    [
      ['link', 1, 0],
      ['attribute.bin', 0, 0],
    ],
  );
});

test('special-key filenames have correct tracked and untracked status counts', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => ({
      ok: true,
      stdout:
        args[0] === 'status'
          ? '?? __proto__\0 M constructor\0'
          : args[0] === 'rev-parse'
            ? '/repo'
            : args[1] === '--no-index'
              ? '3\t0\t\0/dev/null\0__proto__\0'
              : '2\t1\tconstructor\0',
    }),
    fs: { existsSync: () => true },
  });
  assert.deepEqual(await queries.gitStatus('/repo'), {
    files: [
      { code: '??', path: '__proto__', added: 3, removed: 0 },
      { code: ' M', path: 'constructor', added: 2, removed: 1 },
    ],
  });
});

test('tracked filenames containing tabs keep their actual line counts', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => ({
      ok: true,
      stdout: args[0] === 'status' ? ' M tab\tname.txt\0' : '3\t1\ttab\tname.txt\0',
    }),
    fs: { existsSync: () => true },
  });
  assert.deepEqual(await queries.gitStatus('/repo'), { files: [{ code: ' M', path: 'tab\tname.txt', added: 3, removed: 1 }] });
});

test('failed or missing untracked numstat records make status unavailable', async () => {
  for (const result of [
    { ok: false, code: 128, stdout: '' },
    { ok: false, code: 1, stdout: '' },
    { ok: true, stdout: 'garbage' },
    { ok: true, stdout: '1\t0\tother.txt\0' },
  ]) {
    const queries = createGitQueries({
      run: async (_cmd: string, args: string[]) =>
        args[1] === '--no-index'
          ? result
          : { ok: true, stdout: args[0] === 'status' ? '?? unreadable\0' : args[0] === 'rev-parse' ? '/repo' : '' },
      fs: { existsSync: () => true },
    });
    assert.equal(await queries.gitStatus('/repo'), null);
  }
});

test('status counts staged working files before the first commit', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') return { ok: true, stdout: 'AM staged.txt\0' };
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/heads/main\n' };
      if (args[0] === 'show-ref') return { ok: false, code: 1, stdout: '' };
      if (args[0] === 'hash-object') return { ok: true, stdout: 'empty-tree' };
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true' };
      if (args[0] === 'diff' && args[1] === 'empty-tree') return { ok: true, stdout: '2\t0\tstaged.txt\0' };
      return { ok: false, stdout: '', stderr: 'no HEAD' };
    },
    fs: { existsSync: () => true },
  });
  assert.deepEqual(await queries.gitStatus('/repo'), { files: [{ code: 'AM', path: 'staged.txt', added: 2, removed: 0 }] });
});

test('failed tracked stats are unavailable rather than reported as zero lines', async () => {
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) =>
      args[0] === 'status' ? { ok: true, stdout: ' M changed.txt\0' } : { ok: false, stdout: '', stderr: 'read failed' },
    fs: { existsSync: () => true },
  });
  assert.equal(await queries.gitStatus('/repo'), null);
});

test('empty and nonempty untracked numstat counts are returned verbatim', async () => {
  for (const count of [0, 1, 2]) {
    const queries = createGitQueries({
      run: async (_cmd: string, args: string[]) =>
        args[1] === '--no-index'
          ? { ok: false, code: 1, stdout: `${count}\t0\t\0/dev/null\0new.txt\0` }
          : { ok: true, stdout: args[0] === 'status' ? '?? new.txt\0' : args[0] === 'rev-parse' ? '/repo' : '' },
      fs: { existsSync: () => true },
    });
    assert.equal((await queries.gitStatus('/repo')).files[0].added, count);
  }
});

test('untracked status totals use the repository root and binary Git counts', async () => {
  const names: string[] = [];
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[], options: { cwd: string }) => {
      if (args[1] === '--no-index') {
        assert.equal(options.cwd, '/repo');
        const name = args.at(-1)!;
        names.push(name);
        return { ok: false, code: 1, stdout: `${name === 'image.bin' ? '-\t-' : '1\t0'}\t\0/dev/null\0${name}\0` };
      }
      assert.equal(options.cwd, '/repo/sub');
      return { ok: true, stdout: args[0] === 'status' ? '?? sub/new.txt\0?? image.bin\0' : args[0] === 'rev-parse' ? '/repo\n' : '' };
    },
    fs: { existsSync: () => true },
  });
  assert.deepEqual(
    (await queries.gitStatus('/repo/sub')).files.map((f: any) => [f.path, f.added]),
    [
      ['sub/new.txt', 1],
      ['image.bin', 0],
    ],
  );
  assert.deepEqual(names, ['sub/new.txt', 'image.bin']);
});

test('an unavailable root does not produce invented untracked totals', async () => {
  for (const root of [
    { ok: false, stdout: '', stderr: 'unavailable' },
    { ok: true, stdout: '' },
  ]) {
    const queries = createGitQueries({
      run: async (_cmd: string, args: string[]) =>
        args[0] === 'rev-parse' ? root : { ok: true, stdout: args[0] === 'status' ? '?? file.txt\0' : '' },
      fs: { existsSync: () => true, readFileSync: () => assert.fail('root was unavailable') },
    });
    assert.equal(await queries.gitStatus('/repo'), null);
  }
});

test('status refuses invented addition counts when HEAD is broken', async () => {
  const calls: string[][] = [];
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'status') return { ok: true, stdout: ' M existing.txt\0' };
      if (args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true' };
      if (args[0] === 'hash-object') return { ok: true, stdout: 'empty-tree' };
      if (args[0] === 'diff' && args[1] === 'empty-tree') return { ok: true, stdout: '100\t0\texisting.txt\0' };
      return { ok: false, code: 128, stdout: '', stderr: 'broken HEAD' };
    },
    fs: { existsSync: () => true },
  });
  assert.equal(await queries.gitStatus('/repo'), null);
  assert.ok(!calls.some((args) => args[0] === 'hash-object'));
});

test('an untracked nested repository is listed without line counts, and the rest of the status still reads', async (t) => {
  const { execFileSync, execFile } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-nested-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(dir, 'vendor', 'lib'), { recursive: true });
  git(path.join(dir, 'vendor', 'lib'), 'init', '-q', '-b', 'main');
  git(path.join(dir, 'vendor', 'lib'), 'commit', '-q', '--allow-empty', '-m', 'lib');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'a\nb\n');
  // the real git, as main runs it: exit code 1 is not an error for `diff --no-index`
  const run = (cmd: string, args: string[], options: { cwd: string }) =>
    new Promise<{ ok: boolean; stdout: string; code?: number }>((resolve) =>
      execFile(cmd, args, { cwd: options.cwd, encoding: 'utf8' }, (error, stdout) =>
        resolve({ ok: !error, stdout, code: (error as { code?: number } | null)?.code }),
      ),
    );
  const status = await createGitQueries({ run }).gitStatus(dir);
  assert.deepEqual(status, {
    files: [
      { code: '??', path: 'new.txt', added: 2, removed: 0 },
      { code: '??', path: 'vendor/lib/', added: 0, removed: 0 },
    ],
  });
  const { createGitDiff } = require('../electron/platform/gitDiff.cjs');
  const diff: string = await createGitDiff(run)(dir);
  assert.match(diff, /\+\+\+ b\/new\.txt/);
  assert.doesNotMatch(diff, /vendor/);
});

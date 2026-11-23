// Electron IPC git-files unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready } from './fixture';

export function registerGitFilesCases() {
  test('sidebar repository reads are local, scoped to the folder, with only sanitized identity returned', async () => {
    const h = await ready();
    assert.equal(await h.invoke('git:sidebarRepository', 'relative'), null);
    const repo = path.join(h.tmp, 'repo');
    h.cp.exec = (_cmd: string, args: string[]) =>
      args[0] === 'rev-parse' ? { stdout: 'true\n' } : { stdout: 'https://token@github.com/Owner/Repo.git\n' };
    assert.equal(await h.invoke('git:sidebarRepository', repo), 'github.com/owner/repo');
    h.cp.exec = () => ({ err: { code: 128 }, stderr: 'fatal: not a git repository' });
    assert.equal(await h.invoke('git:sidebarRepository', path.join(h.tmp, 'other')), null);
    assert.equal(await h.invoke('git:sidebarRepository', 42), null);
    h.cp.exec = () => ({ err: { code: 'EACCES' }, stderr: 'permission denied' });
    assert.equal(await h.invoke('git:sidebarRepository', path.join(h.tmp, 'denied')), null);
    h.cp.exec = () => ({ stdout: 'false' });
    assert.equal(await h.invoke('git:sidebarRepository', path.join(h.tmp, 'bare')), null);
    for (const [folder, stderr] of [
      ['no-origin', 'No such remote'],
      ['origin-error', 'permission denied'],
    ]) {
      h.cp.exec = (_cmd: string, args: string[]) => (args[0] === 'rev-parse' ? { stdout: 'true' } : { err: { code: 1 }, stderr });
      assert.equal(await h.invoke('git:sidebarRepository', path.join(h.tmp, folder)), null);
    }
  });

  test('git: info, status with line counts, diffs with untracked files, commands and patches', async () => {
    const h = await ready();
    const repo = path.join(h.tmp, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, 'nonl.txt'), 'a\nb');
    const out: Record<string, any> = {
      'rev-parse --show-toplevel': { stdout: repo + '\n' },
      'symbolic-ref --quiet --short HEAD': { stdout: 'main\n' },
      'config --get remote.origin.url': { err: { code: 1 } },
      'branch --format=%(refname:short)': { stdout: 'main\n dev \n\n' },
      'status --porcelain=v1 -uall -z': { stdout: ' M mod.txt\0?? new.txt\0?? nonl.txt\0' },
      'diff HEAD --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ --numstat -z': {
        stdout: '3\t1\tmod.txt\0',
      },
      'diff HEAD --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/': { stdout: 'TRACKED\n' },
      'diff HEAD --no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ -- :(literal)new.txt': {
        stdout: 'ONE\n',
      },
      'ls-files --others --exclude-standard -z': { stdout: 'new.txt\0other.txt\0' },
    };
    h.cp.exec = (_cmd: string, args: string[]) => {
      const k = args.join(' ');
      if (k.startsWith('diff --no-index'))
        return args.includes('--numstat')
          ? { err: { code: 1 }, stdout: `2\t0\t\0/dev/null\0${args.at(-1)}\0` }
          : { stdout: `NEW ${args.at(-1)}\n` };
      return out[k] ?? { stdout: '' };
    };
    assert.equal(await h.invoke('git:info', ''), null);
    assert.equal(await h.invoke('git:info', path.join(h.tmp, 'nope')), null);
    assert.deepEqual(await h.invoke('git:info', repo), { root: repo, branch: 'main', remote: '', branches: ['main', 'dev'] });
    assert.equal(h.cp.execCalls[0].opts.cwd, repo);
    assert.deepEqual(await h.invoke('git:status', repo), {
      files: [
        { code: ' M', path: 'mod.txt', added: 3, removed: 1 },
        { code: '??', path: 'new.txt', added: 2, removed: 0 },
        { code: '??', path: 'nonl.txt', added: 2, removed: 0 },
      ],
    });
    assert.equal(await h.invoke('git:status', null), null);
    assert.equal(await h.invoke('git:diff', repo), 'TRACKED\nNEW new.txt\nNEW other.txt\n');
    assert.equal(await h.invoke('git:diff', repo, 'new.txt'), 'ONE\nNEW new.txt\n');
    out['rev-parse --show-toplevel'] = { err: { code: 128 }, stdout: undefined, stderr: undefined };
    assert.equal(await h.invoke('git:info', repo), null);
    out['status --porcelain=v1 -uall -z'] = { err: { message: 'x' } };
    assert.equal(await h.invoke('git:status', repo), null);
    h.cp.exec = () => ({ err: { code: 'ENOENT' }, stderr: 'no gh' });
    assert.deepEqual(await h.invoke('gh:run', repo, ['pr', 'view']), { ok: false, code: 'ENOENT', stdout: '', stderr: 'no gh' });
    assert.deepEqual(h.cp.execCalls.at(-1).cmd, 'gh');
    h.cp.exec = () => ({ stdout: 'x' });
    assert.deepEqual(await h.invoke('git:run', repo, ['log']), { ok: true, code: 0, stdout: 'x', stderr: '' });
    await h.invoke('git:run', repo, ['--no-lazy-fetch', 'merge-base', 'HEAD', 'origin/main']);
    assert.equal(h.cp.execCalls.at(-1).opts.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(h.cp.execCalls.at(-1).opts.env.GIT_ALLOW_PROTOCOL, '');
    assert.deepEqual(h.cp.execCalls.at(-1).args, ['merge-base', 'HEAD', 'origin/main']);
    // patches go through a temp file that is removed afterwards
    let patchText = '';
    h.cp.exec = (_c: string, args: string[]) => ((patchText = fs.readFileSync(args.at(-1)!, 'utf8')), { stdout: '' });
    await h.invoke('git:applyPatch', repo, 'diff', true);
    assert.equal(patchText, 'diff\n');
    const args = h.cp.execCalls.at(-1).args;
    assert.deepEqual(args.slice(0, 4), ['apply', '--whitespace=nowarn', '--unidiff-zero', '-R']);
    assert.equal(fs.existsSync(args.at(-1)), false);
    await h.invoke('git:applyPatch', repo, 'diff\n', false);
    assert.equal(patchText, 'diff\n');
    assert.equal(h.cp.execCalls.at(-1).args.includes('-R'), false);
  });

  test('files: exists, projectless folders, text, images and pasted images', async () => {
    const h = await ready();
    assert.equal(await h.invoke('fs:exists', h.tmp), true);
    // a path a reply names: main resolves it in the chat's folder (electron/platform/messagePath.cjs)
    assert.deepEqual(await h.invoke('fs:messagePath', '.', h.tmp), { path: h.tmp, kind: 'dir' });
    assert.equal(await h.invoke('fs:messagePath', 'missing.txt', h.tmp), null);
    const root = path.join(h.tmp, 'pl');
    assert.deepEqual(await h.invoke('fs:mkdirProjectless', root, '2026-10-10', 'my-chat'), {
      ok: true,
      path: path.join(root, '2026-10-10', 'my-chat'),
    });
    assert.ok(fs.existsSync(path.join(root, '2026-10-10', 'my-chat')));
    // another chat that day with the same name (every voice chat, say) gets a folder of its own
    assert.deepEqual(await h.invoke('fs:mkdirProjectless', root, '2026-10-10', 'my-chat'), {
      ok: true,
      path: path.join(root, '2026-10-10', 'my-chat-2'),
    });
    assert.equal((await h.invoke('fs:mkdirProjectless', root, '2026-10-10', 'my-chat')).path, path.join(root, '2026-10-10', 'my-chat-3'));
    // a thousand of them: it says so rather than sharing one
    const day = path.join(root, '2026-10-11');
    fs.mkdirSync(path.join(day, 'v'), { recursive: true });
    for (let n = 2; n <= 1000; n++) fs.mkdirSync(path.join(day, `v-${n}`));
    assert.deepEqual(await h.invoke('fs:mkdirProjectless', root, '2026-10-11', 'v'), {
      ok: false,
      error: '1000 chats that day already have this name',
    });
    for (const [r, d, s] of [
      [5, 'd', 's'],
      ['rel', 'd', 's'],
      [root, '../x', 's'],
      [root, 'd', 'a/b'],
      [root, '.d', 's'],
      [root, 'd', '.s'],
    ] as const)
      assert.deepEqual(await h.invoke('fs:mkdirProjectless', r, d, s), { ok: false, error: 'invalid folder name' }, `${r} ${d} ${s}`);
    const file = path.join(h.tmp, 'afile');
    fs.writeFileSync(file, '');
    assert.equal((await h.invoke('fs:mkdirProjectless', file, 'd', 's')).ok, false);
    const mk = mock.method(fs, 'mkdirSync', () => {
      throw 'raw';
    });
    try {
      assert.deepEqual(await h.invoke('fs:mkdirProjectless', root, 'd', 's'), { ok: false, error: 'Raw.' });
    } finally {
      mk.mock.restore();
    }
    // the chat's own folder can't be made (not because another chat has it): said, not retried under another name
    const real = fs.mkdirSync;
    const noAccess = mock.method(fs, 'mkdirSync', (p: string, o?: any) => {
      if (o?.recursive) return real(p, o);
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    try {
      assert.deepEqual(await h.invoke('fs:mkdirProjectless', root, 'd2', 's'), { ok: false, error: 'Permission denied.' });
      assert.equal(noAccess.mock.callCount(), 2);
    } finally {
      noAccess.mock.restore();
    }
    fs.writeFileSync(path.join(h.tmp, 't.txt'), 'hello');
    assert.equal(await h.invoke('fs:readText', path.join(h.tmp, 't.txt')), 'hello');
    assert.equal(await h.invoke('fs:readText', path.join(h.tmp, 'none')), null);
    // a path through a file is as missing as no file; one that is there but unreadable rejects, so it isn't taken for empty
    assert.equal(await h.invoke('fs:readText', path.join(h.tmp, 't.txt', 'inside')), null);
    await assert.rejects(async () => h.invoke('fs:readText', h.tmp), { code: 'EISDIR' });
    const denied = mock.method(fs.promises, 'readFile', async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    try {
      await assert.rejects(async () => h.invoke('fs:readText', path.join(h.tmp, 't.txt')), { code: 'EACCES' });
    } finally {
      denied.mock.restore();
    }
    // a file past the limit is refused whole with a clear error, and one that is no regular file is not read
    const big = path.join(h.tmp, 'big.log');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 21 * 1024 * 1024);
    await assert.rejects(async () => h.invoke('fs:readText', big), {
      code: 'EFBIG',
      message: /too large to open \(21 MB; the limit is 20 MB\)/,
    });
    assert.equal(await h.invoke('fs:exists', big), true);
    assert.equal(await h.invoke('fs:exists', path.join(h.tmp, 'none')), false);
    fs.writeFileSync(path.join(h.tmp, 'p.jpg'), 'hi');
    assert.equal(await h.invoke('fs:readImageDataUrl', path.join(h.tmp, 'p.jpg')), 'data:image/jpeg;base64,aGk=');
    assert.equal(await h.invoke('fs:readImageDataUrl', path.join(h.tmp, 'none.png')), null);
    // types a browser only shows by their full name
    fs.writeFileSync(path.join(h.tmp, 'logo.SVG'), 'hi');
    assert.equal(await h.invoke('fs:readImageDataUrl', path.join(h.tmp, 'logo.SVG')), 'data:image/svg+xml;base64,aGk=');
    fs.writeFileSync(path.join(h.tmp, 'f.ico'), 'hi');
    assert.equal(await h.invoke('fs:readImageDataUrl', path.join(h.tmp, 'f.ico')), 'data:image/x-icon;base64,aGk=');
    assert.equal(await h.invoke('fs:saveTempImage', 'nope'), null);
    for (const [mime, ext] of [
      ['jpeg', 'jpg'],
      ['svg+xml', 'svg'],
      ['x-icon', 'ico'],
      ['vnd.microsoft.icon', 'ico'],
      ['png', 'png'],
      ['x.weird', 'xweird'],
    ]) {
      const f = await h.invoke('fs:saveTempImage', `data:image/${mime};base64,aGk=`);
      assert.ok(f.startsWith(path.join(os.tmpdir(), 'sage-codex-attachments', 'paste-')));
      assert.ok(f.endsWith('.' + ext), f);
      assert.equal(fs.readFileSync(f, 'utf8'), 'hi');
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
      fs.rmSync(f);
    }
    // a pasted image older than a day goes at the next paste; a recent one, and other files there, stay (#2144)
    const dir = path.join(os.tmpdir(), 'sage-codex-attachments');
    const old = path.join(dir, 'paste-old-test.png');
    const recent = path.join(dir, 'paste-recent-test.png');
    const other = path.join(dir, 'panel-keep-test');
    for (const f of [old, recent, other]) fs.writeFileSync(f, 'x');
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
    const f = await h.invoke('fs:saveTempImage', 'data:image/png;base64,aGk=');
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(other), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    // a paste file another paste's prune removed after the listing does not fail this paste
    const gone = path.join(dir, 'paste-gone-test.png');
    fs.writeFileSync(gone, 'x');
    const vanished = mock.method(fs.promises, 'lstat', async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    try {
      assert.ok(await h.invoke('fs:saveTempImage', 'data:image/png;base64,aGk='));
    } finally {
      vanished.mock.restore();
    }
    // any other failure reading it still rejects, as before
    const denied2 = mock.method(fs.promises, 'lstat', async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    try {
      await assert.rejects(async () => h.invoke('fs:saveTempImage', 'data:image/png;base64,aGk='), { code: 'EACCES' });
    } finally {
      denied2.mock.restore();
      fs.rmSync(gone, { force: true });
    }
    for (const p of [recent, other, f]) fs.rmSync(p, { force: true });
  });
}

// Path helpers (src/lib/paths.ts) for POSIX and Windows paths. POSIX results must match the
// plain '/'-splitting the app used before Windows support; Windows paths split on both separators.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/ imports its siblings without the `.ts` extension (Vite resolves them); do the same here.
const { parseUserText } = await import('../src/lib/format.ts');
import {
  absPath,
  abbreviateHome,
  assetUrl,
  basename,
  chatFolder,
  codexWorktreeRepo,
  decodeLinkPath,
  dirname,
  fileName,
  foldClaudeWorktree,
  gitPath,
  isAbsolutePath,
  isUnder,
  isWinPath,
  joinPath,
  localLinkParts,
  parentHint,
  pathKey,
  relPath,
  samePath,
  sameDirectory,
} from '../src/lib/paths.ts';

test('only a matching absolute folder can resolve an ambiguous bare link', () => {
  const link = localLinkParts('C:/repo%2fwork/report%20final.md', true);
  assert.equal(decodeLinkPath(link.path, link, 'C:/repo%2fwork'), 'C:/repo%2fwork/report final.md');
  assert.equal(decodeLinkPath(link.path, link, '/C:/repo%2fwork'), 'C:/repo/work/report final.md');
  assert.equal(decodeLinkPath(link.path, link, 'repo%2fwork'), 'C:/repo/work/report final.md');
});

test('Windows paths are recognised by drive letter or UNC prefix', () => {
  for (const p of ['C:\\Users\\bob', 'c:/repo', 'D:', '\\\\server\\share\\x']) assert.equal(isWinPath(p), true, p);
  for (const p of ['/Users/bob', 'src/a.ts', 'C', 'src\\a.ts', '']) assert.equal(isWinPath(p), false, p);
  assert.equal(isAbsolutePath('C:\\x'), true);
  assert.equal(isAbsolutePath('/x'), true);
  assert.equal(isAbsolutePath('x/y'), false);
});

test('basename and dirname: POSIX unchanged', () => {
  assert.equal(basename('/Users/bob/repo'), 'repo');
  assert.equal(basename('/Users/bob/repo/'), 'repo');
  assert.equal(basename('/'), '/');
  assert.equal(basename(''), '');
  assert.equal(dirname('/Users/bob/repo'), '/Users/bob');
  assert.equal(dirname('/repo'), '/');
  // a backslash is an ordinary character in a POSIX name
  assert.equal(basename('/tmp/a\\b'), 'a\\b');
});

test('basename and dirname: Windows', () => {
  assert.equal(basename('C:\\Users\\bob\\repo'), 'repo');
  assert.equal(basename('C:\\Users\\bob\\repo\\'), 'repo');
  assert.equal(basename('C:/Users/bob/repo'), 'repo');
  assert.equal(basename('C:\\Users/bob\\mixed'), 'mixed');
  assert.equal(basename('C:\\'), 'C:');
  assert.equal(dirname('C:\\Users\\bob\\repo'), 'C:\\Users\\bob');
  assert.equal(dirname('C:\\repo'), 'C:\\');
  assert.equal(dirname('C:\\'), 'C:\\');
  assert.equal(dirname('\\\\server\\share\\dir'), '\\\\server\\share');
});

test('joinPath and absPath use the base path’s separator', () => {
  assert.equal(joinPath('/Users/bob', 'Documents/Codex'), '/Users/bob/Documents/Codex');
  assert.equal(joinPath('C:\\Users\\bob', 'Documents/Codex'), 'C:\\Users\\bob\\Documents\\Codex');
  assert.equal(joinPath('C:\\Users\\bob\\', 'x'), 'C:\\Users\\bob\\x');
  assert.equal(joinPath('C:\\repo', 'D:\\other'), 'D:\\other');
  assert.equal(absPath('src/a.ts', '/repo'), '/repo/src/a.ts');
  assert.equal(absPath('/abs/a.ts', '/repo'), '/abs/a.ts');
  assert.equal(absPath('src/a.ts', 'C:\\repo'), 'C:\\repo\\src\\a.ts');
  assert.equal(absPath('C:\\abs\\a.ts', 'C:\\repo'), 'C:\\abs\\a.ts');
  assert.equal(absPath('src/a.ts', null), 'src/a.ts');
});

test('Windows comparisons ignore case, separators and a trailing separator', () => {
  assert.equal(samePath('C:\\Repo', 'c:/repo/'), true);
  assert.equal(samePath('/Repo', '/repo'), false);
  assert.equal(isUnder('C:\\Repo\\src\\a.ts', 'c:\\repo'), true);
  assert.equal(isUnder('C:\\Repo', 'C:\\repo\\'), true);
  assert.equal(isUnder('C:\\Repository', 'C:\\Repo'), false);
  assert.equal(isUnder('/repo/src', '/repo'), true);
  assert.equal(isUnder('/repository', '/repo'), false);
  assert.equal(pathKey('C:/Users/Bob/'), 'c:\\users\\bob');
  assert.equal(pathKey('/Users/Bob'), '/Users/Bob');
  // one key for macOS's two spellings, as samePath takes them
  assert.equal(pathKey('/private/tmp/x'), pathKey('/tmp/x'));
  assert.equal(pathKey('/private/var/y'), '/var/y');
  assert.equal(pathKey('/private/other'), '/private/other');
});

test('relPath and abbreviateHome', () => {
  assert.equal(relPath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(relPath('/other/a.ts', '/repo'), '/other/a.ts');
  assert.equal(relPath('C:\\Repo\\src\\a.ts', 'c:\\repo'), 'src\\a.ts');
  assert.equal(relPath('C:\\repo', 'C:\\repo'), 'C:\\repo');
  assert.equal(abbreviateHome('/Users/bob/repo'), '~/repo');
  assert.equal(abbreviateHome('C:\\Users\\bob\\repo'), '~\\repo');
  assert.equal(abbreviateHome('D:\\work\\repo'), 'D:\\work\\repo');
});

test('fileName and gitPath for relative paths from a Windows agent', () => {
  assert.equal(fileName('src/a.ts'), 'a.ts');
  assert.equal(fileName('src\\a.ts'), 'src\\a.ts');
  assert.equal(fileName('src\\a.ts', true), 'a.ts');
  assert.equal(gitPath('src\\a.ts', true), 'src/a.ts');
  assert.equal(gitPath('src/a\\b.ts'), 'src/a\\b.ts');
});

test('worktree folding and repo inference', () => {
  assert.equal(foldClaudeWorktree('/r/app/.claude/worktrees/x/src'), '/r/app');
  assert.equal(foldClaudeWorktree('C:\\r\\app\\.claude\\worktrees\\x\\src'), 'C:\\r\\app');
  assert.equal(codexWorktreeRepo('/Users/b/.codex/worktrees/ab12/app/src'), 'app');
  assert.equal(codexWorktreeRepo('C:\\Users\\b\\.codex\\worktrees\\ab12\\app'), 'app');
  assert.equal(codexWorktreeRepo('C:\\Users\\b\\app'), null);
});

test('chatFolder groups chats by folder on both platforms', () => {
  const mac = { home: '/Users/b', pl: '/Users/b/Documents/Codex' };
  assert.equal(chatFolder('/Users/b/app', mac.home, mac.pl), '/Users/b/app');
  assert.equal(chatFolder('/Users/b', mac.home, mac.pl), null);
  assert.equal(chatFolder('/', mac.home, mac.pl), null);
  assert.equal(chatFolder('/Users/b/Documents/Codex/2026-01-01/x', mac.home, mac.pl), null);
  assert.equal(chatFolder('/Users/b/.codex/worktrees/1/app', mac.home, mac.pl), null);
  assert.equal(chatFolder('/Users/b/app/.claude/worktrees/w', mac.home, mac.pl), '/Users/b/app');
  const win = { home: 'C:\\Users\\b', pl: 'C:\\Users\\b\\Documents\\Codex' };
  assert.equal(chatFolder('C:\\Users\\b\\app', win.home, win.pl), 'C:\\Users\\b\\app');
  assert.equal(chatFolder('c:\\users\\B', win.home, win.pl), null);
  assert.equal(chatFolder('C:\\', win.home, win.pl), null);
  assert.equal(chatFolder('C:\\Users\\b\\Documents\\Codex\\2026-01-01\\x', win.home, win.pl), null);
  assert.equal(chatFolder('C:\\Users\\b\\.codex\\worktrees\\1\\app', win.home, win.pl), null);
  assert.equal(chatFolder('C:\\Users\\b\\app\\.claude\\worktrees\\w', win.home, win.pl), 'C:\\Users\\b\\app');
  assert.equal(chatFolder(undefined, win.home, win.pl), null);
});

test('parentHint tells same-named folders apart', () => {
  assert.equal(parentHint('/Users/b/work/api', 1), 'work');
  assert.equal(parentHint('/Users/b/work/api', 2), 'b/work');
  assert.equal(parentHint('C:\\Users\\b\\work\\api', 2), 'b\\work');
  assert.equal(parentHint('D:\\api', 1), 'D:');
});

test('projectHints: only projects of a shared name get one, the last parent folders as far as it takes to tell them apart, up to three', async () => {
  const { projectHints } = await import('../shared/paths.mjs');
  const hints = (projects: { id: string; name: string; path?: string | null }[]) => Object.fromEntries(projectHints(projects));
  assert.deepEqual(hints([{ id: 'a', name: 'api', path: '/Users/b/work/api' }]), {}, 'a name no other project has says nothing');
  assert.deepEqual(
    hints([
      { id: 'a', name: 'api', path: '/Users/b/work/api' },
      { id: 'b', name: 'API', path: '/Users/b/play/api' },
      { id: 'c', name: 'web', path: '/Users/b/play/web' },
    ]),
    { a: 'work', b: 'play' },
    'one folder up is enough, and a name is compared whatever its case',
  );
  assert.deepEqual(
    hints([
      { id: 'a', name: 'api', path: '/x/one/shared/api' },
      { id: 'b', name: 'api', path: '/x/two/shared/api' },
    ]),
    { a: 'one/shared', b: 'two/shared' },
    'the next folder up when the first is the same',
  );
  assert.deepEqual(
    hints([
      { id: 'a', name: 'api', path: '/a/b/c/d/api' },
      { id: 'b', name: 'api', path: '/z/b/c/d/api' },
    ]),
    { a: 'b/c/d', b: 'b/c/d' },
    'three folders is the most that is said, even when they still do not differ',
  );
  assert.deepEqual(
    hints([
      { id: 'a', name: 'api', path: 'C:\\Users\\b\\work\\api' },
      { id: 'b', name: 'api', path: 'D:\\api' },
    ]),
    { a: 'work', b: 'D:' },
  );
  assert.deepEqual(
    hints([
      { id: 'a', name: 'api', path: '/Users/b/work/api' },
      { id: 'b', name: 'api' },
      { id: 'c', name: 'api', path: null },
    ]),
    { a: 'work' },
    'a project with no folder gets none',
  );
});

test('assetUrl: POSIX as before, Windows with forward slashes after an empty host', () => {
  assert.equal(assetUrl('/Users/b/a b.png'), 'codex-asset:///Users/b/a%20b.png');
  assert.equal(assetUrl('C:\\Users\\b\\a b.png'), 'codex-asset:///C:/Users/b/a%20b.png');
  assert.equal(new URL(assetUrl('C:\\x\\#1.png')).pathname, '/C:/x/%231.png');
});

test('file mentions with Windows paths are recognised', () => {
  const raw = '# Files mentioned by the user:\n## a.ts: C:\\repo\\a.ts\n## b.ts: /repo/b.ts\n\n## My request:\nhi';
  assert.deepEqual(parseUserText(raw).files, [
    { name: 'a.ts', path: 'C:\\repo\\a.ts' },
    { name: 'b.ts', path: '/repo/b.ts' },
  ]);
});

test('POSIX folder boundaries and relative labels handle trailing separators and filesystem roots', () => {
  for (const root of ['/repo/', '/repo///']) {
    assert.equal(isUnder('/repo', root), true);
    assert.equal(isUnder('/repo/src/a.ts', root), true);
    assert.equal(isUnder('/repository/a.ts', root), false);
    assert.equal(relPath('/repo/src/a.ts', root), 'src/a.ts');
  }
  assert.equal(isUnder('/repo/src', '/'), true);
  assert.equal(isUnder('/', '/'), true);
  assert.equal(isUnder('relative/file', '/'), false);
  assert.equal(isUnder('', '/'), false);
  assert.equal(isUnder('/repo', ''), false);
  assert.equal(relPath('/repo/src/a.ts', '/'), 'repo/src/a.ts');
  assert.equal(relPath('/', '/'), '/');
});

test('home chats stay ungrouped across trailing separators and worktree folding', () => {
  for (const home of ['/Users/alex', '/Users/alex/'])
    for (const cwd of ['/Users/alex', '/Users/alex/', '/Users/alex///']) {
      assert.equal(chatFolder(cwd, home, '/tasks'), null);
      assert.equal(chatFolder('/Users/alex/.claude/worktrees/temporary/child', home, '/tasks'), null);
      assert.equal(chatFolder('/Users/alex/project', home, '/tasks'), '/Users/alex/project');
      assert.equal(chatFolder('/Users/alexander', home, '/tasks'), '/Users/alexander');
    }
});

test('directory identity ignores trailing separators without equating ancestors or neighboring names', () => {
  assert.equal(sameDirectory('/repo', '/repo///'), true);
  assert.equal(sameDirectory('/', '///'), true);
  assert.equal(sameDirectory('C:\\Repo\\', 'c:/repo'), true);
  assert.equal(sameDirectory('/repo/sub', '/repo'), false);
  assert.equal(sameDirectory('/repo', '/repository'), false);
  assert.equal(sameDirectory('', '/repo'), false);
  assert.equal(sameDirectory('/repo', ''), false);
});

test('relative labels preserve equivalent directory roots rather than becoming empty', () => {
  assert.equal(relPath('/repo/', '/repo'), '/repo/');
  assert.equal(relPath('/repo///', '/repo/'), '/repo///');
  assert.equal(relPath('///', '/'), '///');
  assert.equal(relPath('/repository/file', '/repo/'), '/repository/file');
});

test('macOS /private spellings of /tmp, /var and /etc name the same folder', () => {
  assert.equal(isUnder('/private/tmp/a/b', '/tmp/a'), true);
  assert.equal(isUnder('/var/folders/x/y', '/private/var/folders/x'), true);
  assert.equal(isUnder('/private/etc', '/etc'), true);
  assert.equal(isUnder('/private/tmp/a', '/private'), true);
  assert.equal(isUnder('/private/tmpx/a', '/tmp'), false);
  assert.equal(isUnder('/private/home/a', '/home'), false);
  assert.equal(sameDirectory('/private/tmp', '/tmp/'), true);
  assert.equal(samePath('/private/var/x', '/var/x'), true);
  assert.equal(samePath('/private/var/x', '/var/y'), false);
  assert.equal(samePath('C:\\a', '/a'), false);
});

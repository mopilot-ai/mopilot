// electron/session/orchestration/writeScope.cjs: a linked session sharing its parent's folder declares the globs it
// writes; a start whose globs may overlap those of another live session of the same parent there is refused (one with
// no paths covers the whole folder), a lone one needs none, and a turn's edits outside its globs are found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const {
  pathsArg,
  overlaps,
  staticPrefix,
  globRegExp,
  covered,
  relativeTo,
  outsideOf,
  checkScope,
  MAX_PATHS,
  MAX_GLOB_CHARS,
} = require('../electron/session/orchestration/writeScope.cjs');

const invalid = (e: any) => e.code === 'invalid_paths';

test('paths are relative globs, normalized and deduplicated; none passed is null', () => {
  assert.equal(pathsArg(undefined), null);
  assert.equal(pathsArg(null), null);
  assert.deepEqual(pathsArg([' ./src/api/** ', 'src\\api\\**', 'docs//a.md/', '.', './']), ['src/api/**', 'docs/a.md', '**']);
  assert.deepEqual(pathsArg(['a/./b', '{x,y}/*.ts']), ['a/b', '{x,y}/*.ts']);
  for (const bad of [
    'src',
    [],
    Array(MAX_PATHS + 1).fill('a'),
    [1],
    [''],
    ['  '],
    ['x'.repeat(MAX_GLOB_CHARS + 1)],
    ['/etc/passwd'],
    ['~/x'],
    ['C:/x'],
    ['c:x'],
    ['../up'],
    ['a/../../b'],
    ['!negated'],
    ['{a,b'],
    ['a}'],
    ['}{'],
  ])
    assert.throws(() => pathsArg(bad), invalid, JSON.stringify(bad));
});

test('overlap is by static prefix, segment by segment, ignoring case, and conservative', () => {
  const table: [string, string, boolean][] = [
    // disjoint folders and files
    ['src/api/**', 'src/web/**', false],
    ['src/a.ts', 'src/b.ts', false],
    ['src/a.ts', 'src/a.ts.bak', false],
    ['docs/*.md', 'src/**', false],
    ['src/api', 'src/apiv2/**', false],
    // the same file, a folder and what is under it, either way round
    ['src/a.ts', 'src/a.ts', true],
    ['src', 'src/a.ts', true],
    ['src/a.ts', 'src', true],
    ['src/**', 'src/api/x.ts', true],
    ['SRC/API/**', 'src/api/x.ts', true],
    // a pattern before any literal segment covers everything
    ['**', 'docs/a.md', true],
    ['*.md', 'src/a.ts', true],
    ['{src,docs}/**', 'tests/x.ts', true],
    // conservative: these can't share a file, but their prefixes don't tell
    ['src/*.ts', 'src/api/**', true],
    ['src/api*', 'src/apiv2/x', true],
  ];
  for (const [a, b, want] of table) {
    assert.equal(overlaps(a, b), want, `${a} vs ${b}`);
    assert.equal(overlaps(b, a), want, `${b} vs ${a}`);
  }
  assert.deepEqual(staticPrefix('Src/API/**/x.ts'), ['src', 'api']);
  assert.deepEqual(staticPrefix('src/a.ts'), ['src', 'a.ts']);
  assert.deepEqual(staticPrefix('[ab]/c'), []);
});

test('a glob matches a whole relative path: ** spans folders, * and ? stay in one, classes and braces', () => {
  const m = (glob: string, file: string) => globRegExp(glob).test(file);
  assert.ok(m('src/**', 'src/a/b/c.ts'));
  assert.ok(m('**', 'anything/at/all'));
  assert.ok(m('src/**/x.ts', 'src/x.ts'));
  assert.ok(m('src/**/x.ts', 'src/a/b/x.ts'));
  assert.ok(!m('src/**/x.ts', 'src/a/y.ts'));
  assert.ok(m('**/*.md', 'README.md'));
  assert.ok(m('**/*.md', 'docs/a/b.md'));
  assert.ok(m('src/*.ts', 'src/a.ts'));
  assert.ok(!m('src/*.ts', 'src/a/b.ts'));
  // "**" inside a segment is a "*"
  assert.ok(m('src/a**b', 'src/axxb'));
  assert.ok(!m('src/a**b', 'src/a/b'));
  assert.ok(m('src/?.ts', 'src/a.ts'));
  assert.ok(!m('src/?.ts', 'src/ab.ts'));
  assert.ok(m('src/[ab].ts', 'src/b.ts'));
  assert.ok(!m('src/[ab].ts', 'src/c.ts'));
  assert.ok(m('src/[!ab].ts', 'src/c.ts'));
  assert.ok(!m('src/[!ab].ts', 'src/a.ts'));
  assert.ok(m('src/[a-c].ts', 'src/b.ts'));
  // an unclosed "[" is itself
  assert.ok(m('src/[x', 'src/[x'));
  assert.ok(m('{src,docs}/*.md', 'docs/a.md'));
  assert.ok(!m('{src,docs}/*.md', 'tests/a.md'));
  // a "," or "}" outside braces, and regular-expression characters, are themselves
  assert.ok(m('a,b}.(x)+$.ts', 'a,b}.(x)+$.ts'));
  assert.ok(!m('a.ts', 'abts'));
  assert.ok(m('SRC/A.ts', 'src/a.TS'));
});

test('a file is in scope when a glob matches it or a folder it is in', () => {
  const globs = ['src/api', 'docs/*.md'].map(globRegExp);
  assert.ok(covered('src/api', globs));
  assert.ok(covered('src/api/v1/x.ts', globs));
  assert.ok(covered('docs/a.md', globs));
  assert.ok(!covered('docs/a/b.md', globs));
  assert.ok(!covered('src/web/x.ts', globs));
});

test('an edited path is read relative to the folder; one outside it keeps its whole path', () => {
  assert.equal(relativeTo('/repo', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('/repo', 'src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('/repo', '/repo/..foo/x'), '..foo/x');
  assert.equal(relativeTo('/repo', '/elsewhere/a.ts'), '/elsewhere/a.ts');
  assert.equal(relativeTo('/repo', '../sibling/a.ts'), '/sibling/a.ts');
  assert.equal(relativeTo('/repo', '..'), '/');
  assert.equal(relativeTo('/repo', '/repo'), '/repo');
  // Windows: a backslash path in the folder, and one on another drive, which has no relative form
  assert.equal(relativeTo('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32), 'src/a.ts');
  assert.equal(relativeTo('C:\\repo', 'D:\\x\\a.ts', path.win32), 'D:\\x\\a.ts');
});

test('outsideOf names each edited file outside the globs once', () => {
  assert.deepEqual(
    outsideOf(['/repo/src/api/a.ts', '/repo/src/web/b.ts', 'src/web/b.ts', '/tmp/c.ts', '/repo/docs/x.md'], '/repo', [
      'src/api/**',
      'docs',
    ]),
    ['src/web/b.ts', '/tmp/c.ts'],
  );
  assert.deepEqual(outsideOf(['/repo/a.ts'], '/repo', ['**']), []);
});

test('a file named by the folder’s real path is in the folder, as is one named through the link', (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-real-'));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  t.after(() => {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });
  const resolved = fs.realpathSync(real);
  assert.deepEqual(outsideOf([path.join(resolved, 'src/a.ts'), path.join(link, 'src/b.ts')], link, ['src/**']), []);
  assert.deepEqual(outsideOf([path.join(resolved, 'docs/c.md')], link, ['src/**']), ['docs/c.md']);
});

/** The parent's folder holds `kids`: [id, record, state] each. */
function family(kids: [string, any, any?][]) {
  const h = orchestration();
  h.journal.change((d: any) => {
    for (const [id, rec] of kids)
      d.children[id] = {
        parentId: 'top',
        name: id,
        title: id,
        cwd: '/repo',
        useWorktree: false,
        createdAt: 1,
        driven: [],
        lastReport: null,
        ...rec,
      };
  });
  for (const [id, , state] of kids) {
    h.records.set(id, { meta: {} });
    if (state) h.states.set(id, state);
  }
  return h;
}
const working = { turn: 'running' };
const code = (c: string) => (e: any) => e.code === c;

test('a lone session in the folder needs no paths, nor one beside sessions that are idle, archived, elsewhere or another parent’s', () => {
  const h = family([
    ['idle', { paths: null }],
    ['wt', { useWorktree: true }, working],
    ['away', { cwd: '/other' }, working],
    ['old', {}, working],
    ['theirs', { parentId: 'someone' }, working],
  ]);
  h.records.get('old').meta.archived = 5;
  assert.doesNotThrow(() => checkScope(h.orch, 'top', '/repo', null));
  assert.doesNotThrow(() => checkScope(h.orch, 'top', '/repo/', ['**']));
});

test('beside a live session there, a start must declare paths that keep off its paths', () => {
  const h = family([['api', { paths: ['src/api/**'] }, working]]);
  assert.throws(
    () => checkScope(h.orch, 'top', '/repo', null),
    (e: any) => {
      assert.equal(e.code, 'paths_required');
      assert.match(e.message, /api \(api\) works in this folder now/);
      assert.match(e.message, /use_worktree: true/);
      return true;
    },
  );
  assert.throws(() => checkScope(h.orch, 'top', '/repo', []), code('paths_required'));
  assert.throws(
    () => checkScope(h.orch, 'top', '/repo', ['src/**', 'docs/**']),
    (e: any) => {
      assert.equal(e.code, 'paths_overlap');
      assert.match(e.message, /^src\/\*\* may overlap the paths api \(api\) declared \(src\/api\/\*\*\)/);
      return true;
    },
  );
  assert.doesNotThrow(() => checkScope(h.orch, 'top', '/repo', ['src/web/**', 'docs/**']));
});

test('a live session there with no paths may write anywhere: any start beside it is refused', () => {
  for (const state of [working, { turn: 'awaitingUser' }, { queue: [{ id: 'q' }] }]) {
    const h = family([['all', {}, state]]);
    assert.throws(
      () => checkScope(h.orch, 'top', '/repo', ['docs/**']),
      (e: any) => {
        assert.equal(e.code, 'paths_overlap');
        assert.match(e.message, /all \(all\) works in this folder with no declared paths/);
        return true;
      },
    );
  }
  // one waiting for a free slot counts as live too
  const h = family([['next', { paths: [] }]]);
  h.journal.change((d: any) => d.queue.push({ id: 'b', chatId: 'next', item: { id: 'b', text: 'brief' }, at: 1 }));
  assert.throws(() => checkScope(h.orch, 'top', '/repo', ['docs/**']), code('paths_overlap'));
});

test('start_session in the shared folder checks scope before making a chat, and records the declared paths', async () => {
  const h = family([['api', { paths: ['src/api/**'] }, working]]);
  h.userTurn();
  await assert.rejects(
    h.orch.start('top', { background: BACKGROUND, title: 'Web', prompt: 'p', use_worktree: false }),
    code('paths_required'),
  );
  await assert.rejects(
    h.orch.start('top', { background: BACKGROUND, title: 'Web', prompt: 'p', use_worktree: false, paths: ['src/**'] }),
    code('paths_overlap'),
  );
  assert.ok(!h.log.some(([what]) => String(what).startsWith('start')), 'no chat was made');
  await assert.rejects(async () => h.orch.start('top', { background: BACKGROUND, title: 'Web', prompt: 'p', paths: '../x' }), invalid);
  const started = await h.orch.start('top', {
    background: BACKGROUND,
    title: 'Web',
    prompt: 'p',
    use_worktree: false,
    paths: ['src/web/**'],
  });
  assert.deepEqual(started.paths, ['src/web/**']);
  assert.deepEqual(h.journal.child(started.chat_id).paths, ['src/web/**']);
  // in its own worktree it needs none, and paths it passed anyway aren't kept
  const wt = await h.orch.start('top', { background: BACKGROUND, title: 'Docs', prompt: 'p', paths: ['docs/**'] });
  assert.equal(wt.paths, undefined);
  assert.equal(h.journal.child(wt.chat_id).paths, undefined);
});

test('a hand-off into the shared folder declares its paths the same way', async () => {
  const h = family([['api', { paths: ['src/api/**'] }, working]]);
  h.userTurn();
  await assert.rejects(h.orch.handOff('top', { background: BACKGROUND, title: 'Move', remaining_plan: 'rest' }), code('paths_required'));
  const moved = await h.orch.handOff('top', { background: BACKGROUND, title: 'Move', remaining_plan: 'rest', paths: ['tests/**'] });
  assert.deepEqual(h.journal.child(moved.chat_id).paths, ['tests/**']);
});

// scripts/module-boundaries.mjs: each kind of violation a boundary.json rules out, its named exceptions, domain cycles, and
// the ratchet that compares a change with its merge base under the same rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baseTree,
  countByDomain,
  cyclesOf,
  domainOf,
  grown,
  importsOf,
  isShallow,
  main,
  OUTSIDE,
  readBoundaries,
  renamesSince,
  run,
  violationsIn,
} from '../scripts/module-boundaries.mjs';

const json = (layer: string, pub: string[], mayImport: string[], allow: unknown[] = []) =>
  JSON.stringify({ layer, public: pub, mayImport, allow });

// A small main process: a platform layer, a session layer above it and a composition layer on top, shared pure code,
// and one file no domain holds.
const fixture: Record<string, string> = {
  'shared/boundary.json': json('L0', ['*'], []),
  'shared/k.mjs': 'export const k = 1;',
  'electron/platform/boundary.json': json('L1', ['fsx.cjs'], ['L0']),
  'electron/platform/fsx.cjs': "const fs = require('node:fs');\nmodule.exports = require('./inner.cjs');",
  'electron/platform/inner.cjs': "module.exports = require('../../shared/k.mjs');",
  'electron/session/boundary.json': json(
    'L4',
    [],
    ['L0', 'L1'],
    [
      { path: 'electron/session/allowed.cjs', to: 'node:fs', reason: 'reads its own folder' },
      { path: 'electron/session/allowed.cjs', to: 'electron/platform/inner.cjs', reason: 'one internal reach' },
      { path: 'electron/session/narrow.cjs', to: 'electron/platform/inner.cjs', reason: 'one internal reach' },
    ],
  ),
  // through the public entry (fine), into an internal file, the platform, a package
  'electron/session/a.cjs':
    "require('../platform/fsx.cjs');\nrequire('../platform/inner.cjs');\nrequire('node:child_process');\nrequire('react');",
  'electron/session/allowed.cjs': "require('node:fs');\nrequire('../platform/inner.cjs');",
  'electron/session/narrow.cjs': "require('../platform/inner.cjs');\nrequire('electron');",
  // upward, and the edge that closes a cycle with app
  'electron/session/b.cjs': "require('../app/x.cjs');",
  'electron/app/boundary.json': json('L6', ['*'], ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
  'electron/app/x.cjs': "require('../session/a.cjs');",
  // into a file no domain holds, and a type import of another domain's declaration file
  'electron/session/d.cjs': "require('../root.cjs');",
  'electron/session/e.cjs': "/** @typedef {import('../platform/state').S} S */\nimport type { S } from '../platform/state';",
  'electron/platform/state.d.ts': 'export type S = 1;',
  'electron/root.cjs': "require('./session/a.cjs');",
};

function repo(t: { after: (fn: () => void) => void }, files = fixture) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'module-boundaries-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const key = (v: { domain: string; kind: string; from: string; to: string }) => `${v.domain} ${v.kind} ${v.from} → ${v.to}`;

test('each kind of violation is counted for the importing domain, and named exceptions are not', (t) => {
  const dir = repo(t);
  const boundaries = readBoundaries(dir);
  const { violations, unassigned } = violationsIn(boundaries, dir);
  assert.deepEqual(violations.map(key).sort(), [
    'electron/app cycle electron/app → electron/session',
    'electron/session cycle electron/session → electron/app',
    'electron/session internal electron/session/a.cjs → electron/platform/inner.cjs',
    'electron/session internal electron/session/e.cjs → electron/platform/state.d.ts',
    'electron/session outside electron/session/d.cjs → electron/root.cjs',
    'electron/session platform electron/session/a.cjs → node:child_process',
    'electron/session platform electron/session/narrow.cjs → electron',
    'electron/session upward electron/session/b.cjs → electron/app/x.cjs',
  ]);
  assert.deepEqual(unassigned, ['electron/root.cjs']);
  assert.deepEqual(countByDomain({ violations, unassigned }), {
    [OUTSIDE]: 1,
    'electron/app': 1,
    'electron/session': 7,
  });
});

test('the composition layer wires any domain’s files and the platform, and is still held to its layers', (t) => {
  const app = (mayImport: string[]) => json('L6', [], mayImport);
  const files = {
    ...fixture,
    'electron/app/boundary.json': app(['L0', 'L1', 'L4']),
    'electron/app/x.cjs': "require('../session/a.cjs');\nrequire('../platform/inner.cjs');\nrequire('electron');\nrequire('node:fs');",
    'src/boundary.json': json('R6', [], ['L0']),
    'src/x.ts': "import '../electron/platform/inner.cjs';",
    // another composition domain is reached only through its public entry, as within any layer
    'electron/ipc/boundary.json': json('L6', ['entry.cjs'], ['L0']),
    'electron/ipc/entry.cjs': 'module.exports = 1;',
    'electron/ipc/inside.cjs': 'module.exports = 2;',
    'electron/app/y.cjs': "require('../ipc/entry.cjs');\nrequire('../ipc/inside.cjs');",
  };
  const dir = repo(t, files);
  const ofApp = (d: string) =>
    violationsIn(readBoundaries(d), d)
      .violations.filter((v) => v.domain !== 'electron/session' && v.kind !== 'cycle')
      .map(key)
      .sort();
  assert.deepEqual(ofApp(dir), [
    'electron/app internal electron/app/y.cjs → electron/ipc/inside.cjs',
    'src upward src/x.ts → electron/platform/inner.cjs',
  ]);
  // a layer its boundary.json leaves out is still an upward import
  const narrow = repo(t, { ...files, 'electron/app/boundary.json': app(['L0', 'L1']) });
  assert.deepEqual(ofApp(narrow), [
    'electron/app internal electron/app/y.cjs → electron/ipc/inside.cjs',
    'electron/app upward electron/app/x.cjs → electron/session/a.cjs',
    'src upward src/x.ts → electron/platform/inner.cjs',
  ]);
});

test('a domain holds the top-level files its boundary.json names in "files", judged as its own', (t) => {
  const claimed = {
    ...fixture,
    'electron/app/boundary.json': JSON.stringify({
      layer: 'L6',
      public: [],
      mayImport: ['L0', 'L1', 'L4'],
      files: ['electron/root.cjs'],
      allow: [],
    }),
  };
  const dir = repo(t, claimed);
  const boundaries = readBoundaries(dir);
  assert.equal(domainOf('electron/root.cjs', boundaries)?.dir, 'electron/app');
  const { violations, unassigned } = violationsIn(boundaries, dir);
  assert.deepEqual(unassigned, []);
  // session's import of it is now an upward one, and root.cjs's own import of session is app's to judge
  assert.ok(violations.map(key).includes('electron/session upward electron/session/d.cjs → electron/root.cjs'));
  assert.ok(!violations.some((v) => v.from === 'electron/root.cjs'));
  // a nested file, a folder, a file outside the trees, not a list, not a name
  for (const files of [['electron/app/y.cjs'], ['electron/session'], ['tests/x.ts'], 'electron/root.cjs', [7]]) {
    const bad = repo(t, { 'electron/x/boundary.json': JSON.stringify({ layer: 'L6', public: [], mayImport: [], files, allow: [] }) });
    assert.throws(() => readBoundaries(bad), /electron\/x\/boundary\.json: "files" lists code files at the top of a tree/);
  }
  const claim = (layer: string) => JSON.stringify({ layer, public: [], mayImport: [], files: ['electron/root.cjs'], allow: [] });
  const twice = repo(t, { 'electron/x/boundary.json': claim('L6'), 'electron/y/boundary.json': claim('L0') });
  assert.throws(() => readBoundaries(twice), /electron\/y\/boundary\.json: electron\/root\.cjs is already held by electron\/x/);
});

test('a domain is the nearest folder with a boundary.json; a file under none has no domain', (t) => {
  const dir = repo(t, { ...fixture, 'electron/session/inner/boundary.json': json('L4', [], ['L0']) });
  const boundaries = readBoundaries(dir);
  assert.equal(domainOf('electron/session/inner/deep/x.cjs', boundaries)?.dir, 'electron/session/inner');
  assert.equal(domainOf('electron/session/a.cjs', boundaries)?.dir, 'electron/session');
  assert.equal(domainOf('electron/root.cjs', boundaries), null);
});

test('a boundary.json without its fields, or an exception without its path, target or reason, is refused', (t) => {
  const missing = repo(t, { 'electron/x/boundary.json': JSON.stringify({ layer: 'L1', public: [] }) });
  assert.throws(() => readBoundaries(missing), /electron\/x\/boundary\.json: needs "layer", "public", "mayImport" and "allow"/);
  for (const allow of [
    [{ path: 'electron/x/a.cjs', to: 'fs', reason: ' ' }],
    [{ to: 'fs', reason: 'why' }],
    [{ path: 'electron/x/a.cjs', reason: 'an exception for every import of the file' }],
    [null],
  ]) {
    const bad = repo(t, { 'electron/x/boundary.json': json('L1', [], [], allow) });
    assert.throws(() => readBoundaries(bad), /every "allow" entry names a "path", the "to" it may import and a "reason"/);
  }
});

test('importsOf resolves repository files and declaration files, and names platform modules, not packages', (t) => {
  const dir = repo(t, { ...fixture, 'electron/platform/m.d.mts': 'export type M = 1;' });
  assert.deepEqual(importsOf('electron/session/a.cjs', "require('../platform/fsx.cjs'); import x from 'react'; require('fs');", dir), {
    files: ['electron/platform/fsx.cjs'],
    platform: ['fs'],
  });
  // a declaration file by its module's name; a string ending in "from " doesn't swallow the require after it
  const text =
    "import type { M } from '../platform/m.mjs';\nconst l = 'Moved from '; require('../platform/inner.cjs');\nrequire('./nope');";
  assert.deepEqual(importsOf('electron/session/a.cjs', text, dir).files, ['electron/platform/m.d.mts', 'electron/platform/inner.cjs']);
  // every way to reach the file system or Electron's main process
  const platform = "process.getBuiltinModule('node:fs'); require('original-fs'); require('electron/main'); require('electron-log');";
  assert.deepEqual(importsOf('electron/session/a.cjs', platform, dir).platform, ['node:fs', 'original-fs', 'electron/main']);
});

test('a platform module named only as a type loads nothing and is not counted; a load is, whatever is around it', (t) => {
  const dir = repo(t);
  const types = [
    "/** @param {import('node:fs').Stats} st */",
    "/**\n * @param {typeof import('electron')} e\n */",
    "const w = /** @type {import('node:child_process').ChildProcess} */ (x);",
    "import type { Stats } from 'node:fs';",
    "export type { WebContents } from 'electron';",
  ].join('\n');
  assert.deepEqual(importsOf('electron/session/a.cjs', types, dir).platform, []);
  // a glob's '/*' before a require doesn't hide it, nor does a note after it; a runtime import() reads a member
  const loads = [
    "const GLOB = 'src/**/*.ts';",
    "require('node:fs');",
    "const e = require('electron'); // and a note after",
    "import('node:child_process').then(({ spawnSync }) => spawnSync('true'));",
  ].join('\n');
  assert.deepEqual(importsOf('electron/session/a.cjs', loads, dir).platform, ['node:fs', 'electron', 'node:child_process']);
});

test('isShallow reads git’s own answer', () => {
  assert.equal(
    isShallow(() => 'true\n'),
    true,
  );
  assert.equal(
    isShallow(() => 'false\n'),
    false,
  );
});

test('baseTree reads nothing when the base has none of the trees, and leaves no folder behind when git fails', (t) => {
  const dir = repo(t, { 'README.md': 'nothing here' });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const tree = baseTree(git, 'main', dir);
  assert.deepEqual(readdirSync(tree.dir), []);
  tree.cleanup();
  const broken = (args: string[]) => (args[0] === 'merge-base' ? 'deadbeef\n' : 'electron\n');
  assert.throws(() => baseTree(broken, 'main', dir), /deadbeef/);
});

test('cyclesOf gives each group of domains that reach one another, sorted', () => {
  const graph = new Map([
    ['b', new Set(['a'])],
    ['a', new Set(['b', 'c'])],
    ['c', new Set(['d'])],
    ['d', new Set(['c'])],
    ['e', new Set(['a'])],
  ]);
  assert.deepEqual(cyclesOf(graph), [
    ['c', 'd'],
    ['a', 'b'],
  ]);
  assert.deepEqual(cyclesOf(new Map([['a', new Set(['b'])]])), []);
});

test('grown names the domains with more violations than on the base', () => {
  assert.deepEqual(grown({ a: 3, b: 1, c: 2 }, { a: 3, b: 2 }), [{ domain: 'c', now: 2, base: 0 }]);
  assert.deepEqual(grown({ a: 4 }, { a: 3 }), [{ domain: 'a', now: 4, base: 3 }]);
});

test('the ratchet compares with the merge base under today’s rules: a new violation fails, an unchanged tree passes', (t) => {
  const dir = repo(t);
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = (message: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message]);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  commit('base');
  git(['switch', '-q', '-c', 'work']);
  writeFileSync(path.join(dir, 'electron/session/c.cjs'), "require('../platform/inner.cjs');");
  git(['add', '-A']);
  commit('adds an internal reach');
  const lines: string[] = [];
  const result = main(['--base=main'], { git, log: (s: string) => lines.push(s), repoRoot: dir });
  assert.deepEqual(result.grown, [{ domain: 'electron/session', now: 8, base: 7 }]);
  assert.equal(result.unassigned, 1);
  assert.ok(lines.includes('electron/session\t8\t(base 7)'));
  assert.ok(lines.includes(`${OUTSIDE}\t1\t(base 1)`));
  assert.equal(run(['--base=main'], { git, log: () => {}, repoRoot: dir }), 1);
  // a domain whose violations all went, a new domain that has one, and a new file no domain holds; the base is judged by
  // today's rules: session may now import app's layer, so base's upward import of it no longer counts on either side
  rmSync(path.join(dir, 'electron/app/x.cjs'));
  mkdirSync(path.join(dir, 'electron/fresh'));
  writeFileSync(path.join(dir, 'electron/fresh/boundary.json'), json('L5', [], ['L0']));
  writeFileSync(path.join(dir, 'electron/fresh/f.cjs'), "require('node:fs');");
  writeFileSync(path.join(dir, 'electron/extra.cjs'), 'module.exports = 1;');
  const rules = JSON.parse(fixture['electron/session/boundary.json']);
  writeFileSync(path.join(dir, 'electron/session/boundary.json'), JSON.stringify({ ...rules, mayImport: [...rules.mayImport, 'L6'] }));
  git(['add', '-A']);
  commit('moves things');
  // with no --base, origin/main
  git(['update-ref', 'refs/remotes/origin/main', 'main']);
  const moved: string[] = [];
  assert.deepEqual(main([], { git, log: (s: string) => moved.push(s), repoRoot: dir }).grown, [
    { domain: OUTSIDE, now: 2, base: 1 },
    { domain: 'electron/fresh', now: 1, base: 0 },
  ]);
  assert.ok(moved.includes('electron/app\t0\t(base 1)'));
  assert.ok(moved.includes('electron/fresh\t1\t(base 0)'));
  assert.ok(moved.includes('electron/session\t6\t(base 6)'));
  // against itself nothing grew; a base git can't find is an error, never a pass
  assert.equal(run(['--base=work'], { git, log: () => {}, repoRoot: dir }), 0);
  const errors: string[] = [];
  assert.equal(run(['--base=nowhere'], { git, log: () => {}, repoRoot: dir, error: (m: string) => errors.push(m) }), 1);
  assert.match(errors[0], /nowhere/);
});

test('a moved file is judged on the base where it is now: the move adds nothing, an import it gains still grows', (t) => {
  // app as a feature layer, whose imports are judged (the composition layer's would not be)
  const dir = repo(t, { ...fixture, 'electron/app/boundary.json': json('L5', ['*'], ['L0', 'L1', 'L2', 'L3', 'L4']) });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = (message: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message]);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  commit('base');
  git(['switch', '-q', '-c', 'work']);
  // a.cjs reaches platform's insides and child_process: two violations that are app's on both sides once it moves up,
  // where x.cjs's import of it (and the cycle it closed) is app's own on both sides too
  git(['mv', 'electron/session/a.cjs', 'electron/app/a.cjs']);
  writeFileSync(path.join(dir, 'electron/app/x.cjs'), "require('./a.cjs');");
  writeFileSync(path.join(dir, 'electron/root.cjs'), "require('./app/a.cjs');");
  commit('moves a.cjs up');
  const lines: string[] = [];
  assert.deepEqual(main(['--base=main'], { git, log: (s: string) => lines.push(s), repoRoot: dir }).grown, []);
  assert.ok(lines.includes('electron/app\t2\t(base 2)'), lines.join('\n'));
  assert.ok(lines.includes('electron/session\t4\t(base 4)'), lines.join('\n'));
  writeFileSync(
    path.join(dir, 'electron/app/a.cjs'),
    "require('../platform/fsx.cjs');\nrequire('../platform/inner.cjs');\nrequire('node:child_process');\nrequire('react');\nrequire('node:fs');\nrequire('../session/b.cjs');\nrequire('../session/d.cjs');",
  );
  // fs, two of session's insides, and the cycle with session that closes again (counted on both sides)
  commit('and reaches more');
  assert.deepEqual(main(['--base=main'], { git, log: () => {}, repoRoot: dir }).grown, [
    { domain: 'electron/app', now: 6, base: 2 },
    { domain: 'electron/session', now: 5, base: 4 },
  ]);
});

test('a file that moves into a domain from outside every one brings its imports with it, adding nothing', (t) => {
  // a header like a real file's, so git sees the rewritten file as the same one moved
  const header = '// The root of the fixture: one file no domain holds, which reaches into session from outside it.\n';
  const dir = repo(t, { ...fixture, 'electron/root.cjs': `${header}require('./session/a.cjs');` });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = (message: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message]);
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  commit('base');
  git(['switch', '-q', '-c', 'work']);
  // root.cjs (no domain) reaches into session; d.cjs imports it from session. Moved into platform, both stay put:
  // its upward import of session and session's import of platform's insides were already there, just unseen
  mkdirSync(path.join(dir, 'electron/platform/root'), { recursive: true });
  git(['mv', 'electron/root.cjs', 'electron/platform/root/root.cjs']);
  writeFileSync(path.join(dir, 'electron/platform/root/root.cjs'), `${header}require('../../session/a.cjs');`);
  writeFileSync(path.join(dir, 'electron/session/d.cjs'), "require('../platform/root/root.cjs');");
  commit('moves root.cjs into platform');
  const lines: string[] = [];
  assert.deepEqual(main(['--base=main'], { git, log: (s: string) => lines.push(s), repoRoot: dir }).grown, []);
  assert.ok(lines.includes(`${OUTSIDE}\t0\t(base 0)`), lines.join('\n'));
});

test('renamesSince reads only renames', () => {
  const git = () => 'R100\telectron/a.cjs\telectron/b.cjs\nM\telectron/c.cjs\nR087\tlonely\n\n';
  assert.deepEqual([...renamesSince(git, 'sha')], [['electron/a.cjs', 'electron/b.cjs']]);
});

test('the command prints each domain’s count in this checkout', () => {
  const r = spawnSync(process.execPath, ['scripts/module-boundaries.mjs', '--base=HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^electron\/\S+\t\d+\t\(base \d+\)$/m);
  assert.match(r.stdout, /^\(outside any domain\)\t\d+\t\(base \d+\)$/m);
});

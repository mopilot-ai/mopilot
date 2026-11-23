// An invariant test's `export const GUARDS` (scripts/related-tests.mjs guardsOf) scopes when it runs, so a guard too
// narrow silently skips it. Each declared guard must be a tracked path, and must cover every repository folder the
// test, or a helper it loads, names: a folder a test scans through a computed path is one it names somewhere here.
// The declaration must also be one the selector reads, or it would fall back to every path unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardsOf, INVARIANT_TESTS, referencesOf, withoutStubs } from '../scripts/related-tests.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean),
);
const folders = new Set(
  [...tracked].flatMap((f) =>
    f
      .split('/')
      .slice(1)
      .map((_, i, parts) =>
        f
          .split('/')
          .slice(0, i + 1)
          .join('/'),
      ),
  ),
);
const HELPER = /^(?:web\/)?tests\/(?:support|helpers)\//;

/** The test and every helper it loads, through helpers' own imports. */
function textsOf(file: string): string[] {
  const seen = new Set([file]);
  const queue = [file];
  const texts: string[] = [];
  while (queue.length) {
    const next = queue.shift() as string;
    const text = readFileSync(path.join(ROOT, next), 'utf8');
    texts.push(text);
    for (const ref of referencesOf(next, text, ROOT)) if (HELPER.test(ref) && !seen.has(ref)) seen.add(ref), queue.push(ref);
  }
  return texts;
}

/**
 * The tracked folders a text names: a quoted path (`'<area>/<folder>'`, `'../<area>/'`), or one joined from quoted
 * segments (`path.join(ROOT, <area>, <folder>)`), taken to its longest prefix that is a folder. A word with no
 * slash (`'native'`, a harness's name; `['native', 'metadata']`) counts only as a later argument of a path join
 * (`join(ROOT, <area>)`), and a hidden one
 * (`join(home, '.claude')`, a fake's own folder) only with a slash. A named file is an import edge, and stubbed modules
 * don't count.
 */
export function namedFolders(text: string, isFolder: (p: string) => boolean): string[] {
  const out = new Set<string>();
  const code = withoutStubs(text);
  for (const m of code.matchAll(/(,\s*)?['"`]([\w.@-]+(?:\/[\w.@-]+)*)(\/?)['"`]((?:\s*,\s*['"`][\w.@/-]+['"`])*)/g)) {
    const [, comma, first, slash, rest] = m;
    const joined = comma && /\b(?:join|resolve)\((?:[^()]|\([^()]*\))*$/.test(code.slice(Math.max(0, (m.index as number) - 120), m.index));
    if (!slash && !first.includes('/') && (!joined || first.startsWith('.'))) continue;
    // './x' is beside the module that names it (a stub's key, a sibling import), never a folder at the repository's root
    if (first.startsWith('./')) continue;
    const segments = [first, ...[...rest.matchAll(/['"`]([\w.@/-]+)['"`]/g)].map((s) => s[1])];
    for (let i = segments.length; i > 0; i--) {
      const candidate = path.posix.normalize(segments.slice(0, i).join('/')).replace(/^(?:\.\.\/)+|\/$/g, '');
      if (candidate !== '.' && isFolder(candidate)) {
        out.add(`${candidate}/`);
        break;
      }
    }
  }
  // a folder read by a template path (`../electron/app/ipc/${name}.cjs`): the fixed part before the first `${`
  for (const m of code.matchAll(/`((?:\.\.?\/)*[\w.@-]+(?:\/[\w.@-]+)*)\/\$\{/g)) {
    const segments = m[1].split('/').filter((s) => s !== '..' && s !== '.');
    for (let i = segments.length; i > 0; i--) {
      const candidate = segments.slice(0, i).join('/');
      if (isFolder(candidate)) {
        out.add(`${candidate}/`);
        break;
      }
    }
  }
  return [...out].sort();
}

const covers = (guards: string[], folder: string) => guards.some((g) => g === '*' || folder.startsWith(g.endsWith('/') ? g : `${g}/`));

test('namedFolders finds quoted and joined folders, deepest first, and skips stubs', () => {
  const isFolder = (p: string) => ['app', 'app/ui', 'core', 'core/caps'].includes(p);
  assert.deepEqual(namedFolders("read('../app/ui/'); join(ROOT, 'core', 'caps', 'x.cjs'); mock.module('../core/x.cjs')", isFolder), [
    'app/ui/',
    'core/caps/',
  ]);
  assert.deepEqual(namedFolders("readdirSync(join(ROOT, 'app')); read('core/')", isFolder), ['app/', 'core/']);
  // a template path names the folder before its first substitution; a nested call may build the join's root
  assert.deepEqual(namedFolders('read(`../core/caps/${name}.cjs`); load(`app/${x}`); test(`app boundary: ${k}`)', isFolder), [
    'app/',
    'core/caps/',
  ]);
  assert.deepEqual(namedFolders("readdirSync(join(fileURLToPath(ROOT), 'core'))", isFolder), ['core/']);
  // a file, a word that is not a path argument, a hidden word and the root itself name no folder
  assert.deepEqual(namedFolders("'app/ui/a.css' state: 'app' equal(x, 'app') ['app', 'ui'] join(home, '.claude') '..'", isFolder), []);
  // a sibling's key or import names no root folder, even one that shares its name
  assert.deepEqual(namedFolders("const stubs = { './core': '' }; import('./core/x.ts')", isFolder), []);
});

test('every declared GUARDS is readable, names tracked paths, and covers the folders its test names', () => {
  const problems: string[] = [];
  for (const file of INVARIANT_TESTS.filter((f) => existsSync(path.join(ROOT, f)))) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const guards = guardsOf(text);
    const declaration = /^export const GUARDS\b[^\n]*/m.exec(text)?.[0];
    if (declaration && guards.includes('*') && !/['"`]\*['"`]/.test(text.slice(text.indexOf(declaration)).split(']')[0]))
      problems.push(`${file}: GUARDS is not a literal list of strings, so it guards every path`);
    if (guards.includes('*')) continue;
    for (const g of guards)
      if (!(g.endsWith('/') ? folders.has(g.slice(0, -1)) : tracked.has(g) || folders.has(g)))
        problems.push(`${file}: guard ${g} is not a tracked ${g.endsWith('/') ? 'folder' : 'path'}`);
    const named = new Set(textsOf(file).flatMap((t) => namedFolders(t, (p) => folders.has(p))));
    for (const folder of named) if (!covers(guards, folder)) problems.push(`${file}: names ${folder}, which its GUARDS do not cover`);
  }
  assert.deepEqual(problems, []);
});

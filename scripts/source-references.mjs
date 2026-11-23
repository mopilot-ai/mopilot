// What one source or test file points at, for the related-tests graph (scripts/related-tests.mjs): the repository files
// its imports, requires and module-relative URLs resolve to, and (for tests) the repository paths it names. A module a
// test or helper only stubs (`mock.module(…)`, `autoMock(…)`) is not reached: the test never runs it. Nor is a path an
// invariant test only declares it guards.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintReferences } from './lint-references.mjs';
import { treeFiles } from './source-tree.mjs';
import { mayHaveBiomeExecutable } from './biome-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const TEST_DIRS = ['tests', 'web/tests'];
export const SOURCE = /\.(?:[cm]?js|[cm]?ts|[jt]sx|css|sh)$/;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
const EXTENSIONS = ['', ...MODULE_EXTENSIONS, ...MODULE_EXTENSIONS.map((ext) => `/index${ext}`)];
// import x from '…', import '…', export … from '…', import('…'), require('…')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;
// File URLs name executable fixtures too, outside the application-source folders.
const URL_SPECIFIER = /new\s+URL\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url\s*\)/g;
// const req = createRequire(new URL(<a package.json>, import.meta.url)): a require bound to another folder
const BOUND_REQUIRE =
  /\b([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(\s*new\s+URL\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url\s*\)\s*\)/g;
// any quoted path inside the repository's source folders, with or without leading ../ segments
const REPO_PATH = /['"`](?:\.\.\/)*((?:src|electron|shared|scripts|mobile)\/[\w./-]+)['"`]/g;
// path.join(ROOT, 'electron', 'app.cjs'): a source folder followed by quoted path segments
const JOINED_PATH = /['"`](src|electron|shared|scripts|mobile)['"`]((?:\s*,\s*['"`][\w.-]+['"`])+)/g;
// node:test's module mock, and tests/support/thread-kit.ts's autoMock over it: the first argument names a stub
const STUB_CALL = /\b(?:mock\.module|autoMock)\s*\(/g;
/** An invariant test's `export const GUARDS = [...]` (scripts/related-tests.mjs guardsOf): paths it guards, not reads. */
export const GUARDS_DECLARATION = /^export const GUARDS\b[^=]*=\s*\[([^\]]*)\]/m;

// generated protocol types are never part of the graph; hidden folders (.next, lint fixtures) never are either
export const walk = (/** @type {string} */ dir) =>
  treeFiles(dir, SOURCE, { skip: (p, isDirectory) => isDirectory && path.basename(p) === 'protocol' });

/** Whether a match starts in a `//` comment or inside a quoted string on its line, where it is text, not a call. */
function inText(/** @type {string} */ text, /** @type {number} */ at) {
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  if (/\/\/|^\s*\*/.test(line)) return true;
  return ["'", '"', '`'].some((q) => line.split(q).length % 2 === 0);
}

/**
 * `text` with the string literals in each stub call's first argument emptied, whatever builds the specifier
 * (`'../src/x.ts'`, `new URL('../src/x.ts', import.meta.url).href`, `require.resolve('…')`): a module a test replaces
 * is not one it runs. The rest of the text, the stub's exports included, keeps its references. A call named in a
 * comment or a string is not one.
 */
export function withoutStubs(/** @type {string} */ text) {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(STUB_CALL)) {
    const start = m.index + m[0].length;
    if (start < from || inText(text, m.index)) continue;
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === "'" || c === '"' || c === '`') {
        const close = text.indexOf(c, end + 1);
        if (close < 0) break;
        end = close;
      } else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (!depth) break;
        depth--;
      } else if (c === ',' && !depth) break;
    }
    out += text.slice(from, start) + text.slice(start, end).replace(/(['"`])[^'"`]*\1/g, '$1$1');
    from = end;
  }
  return out + text.slice(from);
}

/** The repository file a specifier points at, or null for packages and files that don't exist. */
export function resolveSpecifier(specifier, fromFile, repoRoot = root) {
  // Cache-busting queries and fragments name the same source file in the coverage report.
  specifier = specifier.replace(/[?#].*$/, '');
  // the web app's `@/…` alias (web/tsconfig.json) means its own root
  const inWeb = !path.relative(path.join(repoRoot, 'web'), fromFile).startsWith('..');
  const base = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : inWeb && specifier.startsWith('@/')
      ? path.join(repoRoot, 'web', specifier.slice(2))
      : null;
  if (!base) return null;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.relative(repoRoot, candidate);
  }
  return null;
}

/**
 * The files a templated relative import can load (`import(\`../app/admin/${p}\`)`): every source file under the folder
 * its fixed part names. Tests that load each page or route by name this way were otherwise never selected for a change
 * to one of them.
 */
function templatedTargets(specifier, fromFile, repoRoot) {
  const fixed = specifier.replace(/[?#].*$/, '');
  const at = fixed.indexOf('${');
  if (at < 0 || !fixed.startsWith('.')) return [];
  const dir = path.resolve(path.dirname(fromFile), fixed.slice(0, fixed.lastIndexOf('/', at) + 1));
  const inRepo = path.relative(repoRoot, dir);
  if (inRepo.startsWith('..') || path.isAbsolute(inRepo) || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return walk(dir).map((file) => path.relative(repoRoot, file));
}

/** What a file points at: resolved relative specifiers, plus (for tests) the repository paths it names. */
export function referencesOf(file, text, repoRoot = root) {
  const out = new Set();
  const abs = path.join(repoRoot, file);
  const code = withoutStubs(text).replace(GUARDS_DECLARATION, '');
  for (const m of code.matchAll(SPECIFIER)) {
    const target = resolveSpecifier(m[1], abs, repoRoot);
    if (target) out.add(target);
    else for (const file of templatedTargets(m[1], abs, repoRoot)) out.add(file);
  }
  // A require made by createRequire for another folder resolves its specifiers from there (#4354: a test that loads
  // the phone app's Expo config through one was never selected for a change to it).
  for (const bound of code.matchAll(BOUND_REQUIRE)) {
    // a URL of a folder (ending in a slash) resolves from inside it, a URL of a file from the folder it is in
    const url = bound[2].replace(/[?#].*$/, '');
    const base = path.resolve(path.dirname(abs), url.endsWith('/') ? `${url}x` : url);
    const name = bound[1].replace(/\$/g, '\\$');
    const call = new RegExp(`(?<![\\w$.])${name}(?:\\.resolve)?\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    for (const m of code.matchAll(call)) {
      const target = resolveSpecifier(m[1], base, repoRoot);
      if (target) out.add(target);
    }
  }
  // Resolve literal module-relative URLs; a dynamic URL is not an import of every file under its prefix.
  for (const m of code.matchAll(URL_SPECIFIER)) {
    const target = resolveSpecifier(m[1], abs, repoRoot);
    if (target) out.add(target);
  }
  const named = [...code.matchAll(REPO_PATH)].map((m) => m[1]);
  for (const m of code.matchAll(JOINED_PATH)) named.push([m[1], ...[...m[2].matchAll(/['"`]([\w.-]+)['"`]/g)].map((s) => s[1])].join('/'));
  for (const name of named) {
    // an installed package's file exists only where the job installed that folder's dependencies: it stands for the
    // package.json that installs it (in every checkout, and what a dependency bump changes), so every job builds the same graph
    const installed = /^((?:[\w.-]+\/)*?)node_modules\//.exec(name);
    if (installed) {
      if (existsSync(path.join(repoRoot, installed[1], 'package.json'))) out.add(`${installed[1]}package.json`);
      continue;
    }
    const target = resolveSpecifier(`./${name}`, path.join(repoRoot, 'x'), repoRoot);
    if (target) out.add(target);
    // a folder a test scans (every component's source, say) reaches each source file in it
    else if (existsSync(path.join(repoRoot, name)) && statSync(path.join(repoRoot, name)).isDirectory()) {
      for (const file of walk(path.join(repoRoot, name))) out.add(path.relative(repoRoot, file));
    }
  }
  // The sweep builds this graph before npm install. Conservatively include candidates, even inert source samples:
  // extra config edges only select extra tests; exact ownership enforcement belongs to the separate AST guard.
  if (!file.endsWith('.css') && mayHaveBiomeExecutable(text)) out.add('biome.json');
  if (TEST_DIRS.some((d) => file.startsWith(`${d}/`))) for (const key of lintReferences(text, repoRoot)) out.add(key);
  return out;
}

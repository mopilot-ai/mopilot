// The layering rules of docs/architecture/modularization.md §2 and §4, checked from each domain's boundary.json: a module
// imports only its own layer or the layers its domain may import, another domain only through that domain's public
// entries, the platform (fs, child_process, electron) only from L1, and no two domains import each other. Counted per
// domain, so tests/moduleBoundaries.invariant.test.ts can fail a change that adds a violation without a hand-kept list.
//
//   node scripts/module-boundaries.mjs [--base=origin/main]   (each domain's count, here and on the merge base)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecifier } from './related-tests.mjs';
import { treeFiles } from './source-tree.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
/** The trees the rules cover. */
export const TREES = ['electron', 'src', 'shared'];
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx)$/;
// import x from '…', import '…', export … from '…', import('…'), require('…'), process.getBuiltinModule('…'); a specifier
// has no whitespace, so a string that merely ends in "from " doesn't swallow the next real one. A path computed at run
// time (`require(path.join(…))`, a template) is not seen: name the module literally.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bgetBuiltinModule\s*\(\s*)['"`]([^'"`\s]+)['"`]/g;
/** What only L1 may require (§2): the file system, child processes and Electron. */
const PLATFORM = /^(?:node:)?(?:fs|fs\/promises|child_process|original-fs)$|^electron(?:\/(?:main|renderer|common|utility))?$/;
/** The count of code files no domain holds, ratcheted like a domain's: a new one, or one moved out of its domain, fails. */
export const OUTSIDE = '(outside any domain)';
const PLATFORM_LAYER = 'L1';
/** The composition layer (§2: it wires everything and nothing imports it), which may build any lower domain's files. */
const COMPOSITION = 'L6';

/**
 * A domain's rules; `public: ['*']` makes every file public (shared/'s pure modules, generated protocol types).
 * @typedef {{ dir: string, layer: string, public: string[], mayImport: string[], allow: { path: string, to: string, reason: string }[] }} Boundary
 * @typedef {{ domain: string, kind: 'upward' | 'internal' | 'platform' | 'outside' | 'cycle', from: string, to: string }} Violation
 */

/**
 * Every boundary.json under the trees, by its folder, checked for the fields §4 names. A domain's optional `files` names
 * files at a tree's top that belong to it (§2 places `electron/ignored.cjs` in L0 and `electron/main.cjs` in L6), keyed
 * here by their own path.
 */
export function readBoundaries(repoRoot = root, read = (/** @type {string} */ f) => readFileSync(path.join(repoRoot, f), 'utf8')) {
  /** @type {Map<string, Boundary>} */
  const out = new Map();
  for (const tree of TREES) {
    if (!existsSync(path.join(repoRoot, tree))) continue;
    for (const abs of treeFiles(path.join(repoRoot, tree), /^boundary\.json$/)) {
      const file = path.relative(repoRoot, abs).split(path.sep).join('/');
      const b = JSON.parse(read(file));
      const dir = path.posix.dirname(file);
      if (typeof b.layer !== 'string' || !Array.isArray(b.public) || !Array.isArray(b.mayImport) || !Array.isArray(b.allow))
        throw new Error(`${file}: needs "layer", "public", "mayImport" and "allow"`);
      for (const a of b.allow)
        if (typeof a?.path !== 'string' || typeof a?.to !== 'string' || typeof a?.reason !== 'string' || !a.reason.trim())
          throw new Error(`${file}: every "allow" entry names a "path", the "to" it may import and a "reason"`);
      const files = b.files ?? [];
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || !TREES.includes(path.posix.dirname(f)) || !CODE.test(f)))
        throw new Error(`${file}: "files" lists code files at the top of a tree (electron/main.cjs)`);
      const boundary = { dir, layer: b.layer, public: b.public, mayImport: b.mayImport, allow: b.allow };
      out.set(dir, boundary);
      for (const f of files) {
        if (out.has(f)) throw new Error(`${file}: ${f} is already held by ${out.get(f)?.dir}`);
        out.set(f, boundary);
      }
    }
  }
  return out;
}

/** The domain a file belongs to: the domain that names it in `files`, else the nearest folder above it with a boundary.json, or null. */
export function domainOf(/** @type {string} */ file, /** @type {Map<string, Boundary>} */ boundaries) {
  const named = boundaries.get(file);
  if (named) return named;
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
    const b = boundaries.get(dir);
    if (b) return b;
  }
  return null;
}

/**
 * The repository file a relative specifier names: the module itself, else its declaration file (`../store/state` →
 * state.d.ts, `./x.mjs` → x.d.mts), which a type import reaches as much as any other.
 */
function resolveImport(/** @type {string} */ specifier, /** @type {string} */ from, /** @type {string} */ repoRoot) {
  const found = resolveSpecifier(specifier, from, repoRoot);
  if (found || !specifier.startsWith('.')) return found;
  const bare = specifier.replace(/[?#].*$/, '');
  const js = /\.([cm]?)js$/.exec(bare);
  const stem = path.resolve(path.dirname(from), js ? bare.slice(0, -js[0].length) : bare);
  for (const ext of js ? [`.d.${js[1]}ts`] : ['.d.ts', '.d.mts', '.d.cts'])
    if (existsSync(stem + ext)) return path.relative(repoRoot, stem + ext);
  return null;
}

/**
 * Whether the match at `at` (its specifier ending at `end`) names the module only as a type, which loads nothing: a
 * type query, `typeof import('electron')` or `import('node:fs').Stats` (a capitalized member), or an `import type` /
 * `export type` statement. A runtime `import('node:child_process').then(...)` or a require is never one.
 */
function typeOnly(/** @type {string} */ text, /** @type {number} */ at, /** @type {number} */ end) {
  if (text.startsWith('import(', at)) return /typeof\s*$/.test(text.slice(0, at)) || /^\)\.[A-Z]/.test(text.slice(end));
  const line = text.slice(text.lastIndexOf('\n', at) + 1, at);
  return /^\s*(?:import|export)\s+type\b/.test(line);
}

/**
 * Each code file's imports and requires: repository files it resolves to (a type import too: it ties the file to
 * that module's shape), and the platform modules it loads.
 */
export function importsOf(/** @type {string} */ file, /** @type {string} */ text, repoRoot = root) {
  const files = new Set();
  const platform = new Set();
  for (const m of text.matchAll(SPECIFIER)) {
    if (PLATFORM.test(m[1]) && !typeOnly(text, m.index, m.index + m[0].length)) platform.add(m[1]);
    const target = resolveImport(m[1], path.join(repoRoot, file), repoRoot);
    if (target) files.add(target.split(path.sep).join('/'));
  }
  return { files: [...files], platform: [...platform] };
}

/** Whether one of the domain's exceptions names this import: an exception covers one file's one import, never more. */
const excused = (/** @type {Boundary} */ b, /** @type {string} */ from, /** @type {string} */ to) =>
  b.allow.some((a) => a.path === from && a.to === to);

/**
 * Every violation in a tree, under `boundaries` (which may come from another tree: the ratchet judges the merge base by
 * today's rules), and the code files no domain holds. `placed` (a tree path -> where that file is now) judges a file the
 * change moved, and each import of it, where it is now, so a move adds and removes nothing by itself, even a file that
 * moves into a domain from outside every one (whose imports were never counted).
 * @param {Map<string, Boundary>} boundaries
 * @param {Map<string, string>} [placed]
 * @returns {{ violations: Violation[], unassigned: string[] }}
 */
export function violationsIn(
  boundaries,
  repoRoot = root,
  read = (/** @type {string} */ f) => readFileSync(path.join(repoRoot, f), 'utf8'),
  placed = new Map(),
) {
  const at = (/** @type {string} */ f) => placed.get(f) ?? f;
  /** @type {Violation[]} */
  const violations = [];
  const unassigned = [];
  /** @type {Map<string, Set<string>>} domain -> the domains it imports */
  const graph = new Map();
  for (const tree of TREES) {
    if (!existsSync(path.join(repoRoot, tree))) continue;
    for (const abs of treeFiles(path.join(repoRoot, tree), CODE)) {
      const inTree = path.relative(repoRoot, abs).split(path.sep).join('/');
      const file = at(inTree);
      const own = domainOf(file, boundaries);
      if (!own) {
        unassigned.push(file);
        continue;
      }
      const { files, platform } = importsOf(inTree, read(inTree), repoRoot);
      if (own.layer !== PLATFORM_LAYER && own.layer !== COMPOSITION)
        for (const p of platform) if (!excused(own, file, p)) violations.push({ domain: own.dir, kind: 'platform', from: file, to: p });
      for (const target of files.map(at)) {
        const other = domainOf(target, boundaries);
        if (other === own || excused(own, file, target)) continue;
        // a file no domain holds can't pass an import on unseen (a domain → a top-level file → another domain's insides)
        if (!other) {
          violations.push({ domain: own.dir, kind: 'outside', from: file, to: target });
          continue;
        }
        if (!graph.has(own.dir)) graph.set(own.dir, new Set());
        graph.get(own.dir)?.add(other.dir);
        if (other.layer !== own.layer && !own.mayImport.includes(other.layer))
          violations.push({ domain: own.dir, kind: 'upward', from: file, to: target });
        else if (
          !(own.layer === COMPOSITION && other.layer !== COMPOSITION) &&
          !other.public.includes('*') &&
          !other.public.includes(path.posix.relative(other.dir, target))
        )
          violations.push({ domain: own.dir, kind: 'internal', from: file, to: target });
      }
    }
  }
  // each domain in a cycle once for every other domain in it, so two cycles joined into one count for more
  for (const group of cyclesOf(graph))
    for (const domain of group)
      for (const other of group) if (other !== domain) violations.push({ domain, kind: 'cycle', from: domain, to: other });
  return { violations, unassigned };
}

/**
 * The domain cycles: each group of domains that reach one another (a strongly connected component of two or more),
 * as one cycle through it in a stable order.
 * @param {Map<string, Set<string>>} graph
 */
export function cyclesOf(graph) {
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flatMap((s) => [...s])])].sort();
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  /** @type {string[][]} */
  const groups = [];
  let next = 0;
  const visit = (/** @type {string} */ v) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of [...(graph.get(v) ?? [])].sort()) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (low.get(w))));
      } else if (onStack.has(w)) low.set(v, Math.min(/** @type {number} */ (low.get(v)), /** @type {number} */ (index.get(w))));
    }
    if (low.get(v) === index.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return groups;
}

/** Violations per domain, sorted by domain, and the files no domain holds under OUTSIDE. */
export function countByDomain(/** @type {{ violations: Violation[], unassigned: string[] }} */ { violations, unassigned }) {
  /** @type {Record<string, number>} */
  const counts = { [OUTSIDE]: unassigned.length };
  for (const v of violations) counts[v.domain] = (counts[v.domain] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The files moved (git renames) between the merge base and this checkout's files: base path -> path here.
 * @param {(args: string[]) => string} git
 */
export function renamesSince(git, /** @type {string} */ sha) {
  /** @type {Map<string, string>} */
  const moved = new Map();
  for (const line of git(['diff', '-M', '--name-status', '--diff-filter=R', sha, '--', ...TREES]).split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to) moved.set(from, to);
  }
  return moved;
}

/** The domains with more violations now than on the base, each with both counts. */
export function grown(/** @type {Record<string, number>} */ now, /** @type {Record<string, number>} */ base) {
  return Object.entries(now)
    .filter(([domain, n]) => n > (base[domain] ?? 0))
    .map(([domain, n]) => ({ domain, now: n, base: base[domain] ?? 0 }));
}

/**
 * The merge base's code trees, extracted into a temporary folder (as scripts/merge-gate.mjs reads a tested tree), with
 * a cleanup. Throws when the base can't be found: the ratchet never passes for want of something to compare.
 * @param {(args: string[]) => string} git
 */
export function baseTree(git, base = 'origin/main', repoRoot = root) {
  const sha = git(['merge-base', base, 'HEAD']).trim();
  const present = git(['ls-tree', '--name-only', sha, '--', ...TREES])
    .split('\n')
    .filter(Boolean);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'module-boundaries-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    // with no paths git archive would pack the whole tree; with none of the trees there is nothing to read
    if (present.length) {
      const archive = execFileSync('git', ['archive', sha, '--', ...present], { cwd: repoRoot, maxBuffer: 1 << 30 });
      execFileSync('tar', ['-x', '-C', dir], { input: archive });
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { sha, dir, cleanup };
}

/** Whether this checkout has only the newest commit (the public runner's on main): there is no merge base to compare. */
export const isShallow = (/** @type {(args: string[]) => string} */ git) => git(['rev-parse', '--is-shallow-repository']).trim() === 'true';

export function main(
  /** @type {string[]} */ args,
  {
    git = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }),
    log = console.log,
    repoRoot = root,
  } = {},
) {
  const base = args.find((a) => a.startsWith('--base='))?.slice(7) ?? 'origin/main';
  const boundaries = readBoundaries(repoRoot);
  const here = violationsIn(boundaries, repoRoot);
  const tree = baseTree(git, base, repoRoot);
  try {
    const then = violationsIn(boundaries, tree.dir, undefined, renamesSince(git, tree.sha));
    const now = countByDomain(here);
    const was = countByDomain(then);
    // every domain, a clean one at 0 too, so the output shows where each stands
    const domains = [...new Set([...boundaries.values()].map((b) => b.dir))];
    for (const domain of [...new Set([...domains, OUTSIDE, ...Object.keys(now), ...Object.keys(was)])].sort())
      log(`${domain}\t${now[domain] ?? 0}\t(base ${was[domain] ?? 0})`);
    return { now, was, grown: grown(now, was), unassigned: here.unassigned.length };
  } finally {
    tree.cleanup();
  }
}

/** The command's exit code: 1 when a domain gained a violation or the comparison failed (its reason to `error`). */
/**
 * @param {string[]} args
 * @param {{ error?: (message: string) => void } & Parameters<typeof main>[1]} [options]
 */
export function run(args, { error = console.error, ...deps } = {}) {
  try {
    return main(args, deps).grown.length ? 1 : 0;
  } catch (e) {
    error(/** @type {Error} */ (e).message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));

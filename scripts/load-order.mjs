// Load-order hazards in import cycles: a module that, while it loads, reads a value it imports from a module in its own
// import cycle. That module may not have finished, so the binding is uninitialized: the dev server's native modules throw
// (ReferenceError), and the bundled app may read undefined and fail silently, as task Stop did (#2525). A function
// declaration is initialized before any module code runs, so reading one is safe; a const, let or class is not. Read it
// when called instead (inside a function), as src/store/agentWiring.ts's wireAgentSurfaces does.
//
//   node scripts/load-order.mjs   (every hazard in src/ and shared/)
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cyclesOf } from './module-boundaries.mjs';
import { treeFiles } from './source-tree.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const CODE = /\.(?:ts|tsx|mjs)$/;
/** Code that runs only when called: a reference inside it is not read at load. */
const DEFERRED = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody']);

/** @typedef {{ file: string, name: string, from: string, imported: string, kind: string }} Hazard */

/** The oxc parser Vite builds the app with, from this checkout's dependencies. */
const parseSync = createRequire(path.join(root, 'package.json'))('vite').parseSync;

/** The repository file a relative specifier names, with its extension, or null. */
export function resolveModule(/** @type {string} */ specifier, /** @type {string} */ fromFile, repoRoot = root) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier);
  for (const ext of ['', '.ts', '.tsx', '.mjs', '/index.ts'])
    if (CODE.test(base + ext) && !(base + ext).endsWith('.d.ts') && existsSync(base + ext))
      return path
        .relative(repoRoot, base + ext)
        .split(path.sep)
        .join('/');
  return null;
}

/**
 * A module's value imports and re-exports (type-only ones left out), and the top-level declarations it makes, from its
 * parsed program.
 */
export function moduleFacts(/** @type {string} */ file, /** @type {string} */ text, repoRoot = root) {
  const program = parseSync(file, text).program;
  /** @type {Map<string, { from: string, name: string }>} local name -> where it comes from */
  const imports = new Map();
  /** @type {Set<string>} */
  const deps = new Set();
  /** @type {Map<string, string>} top-level name -> declaration kind */
  const declared = new Map();
  /** @type {Map<string, { from: string, name: string } | { local: string }>} exported name -> its origin */
  const exported = new Map();
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') {
      if (st.importKind === 'type') continue;
      const from = resolveModule(st.source.value, file, repoRoot);
      if (!from) continue;
      const values = st.specifiers.filter((/** @type {any} */ s) => s.importKind !== 'type');
      if (values.length || !st.specifiers.length) deps.add(from);
      for (const s of values)
        if (s.type === 'ImportSpecifier') imports.set(s.local.name, { from, name: s.imported.name ?? s.imported.value });
      continue;
    }
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (st.type === 'ExportNamedDeclaration' && st.source && st.exportKind !== 'type') {
      const from = resolveModule(st.source.value, file, repoRoot);
      if (from) {
        deps.add(from);
        for (const s of st.specifiers) exported.set(s.exported.name ?? s.exported.value, { from, name: s.local.name ?? s.local.value });
      }
    } else if (st.type === 'ExportNamedDeclaration' && !st.declaration)
      for (const s of st.specifiers) exported.set(s.exported.name ?? s.exported.value, { local: s.local.name });
    /** @type {[string, string][]} */
    const names =
      decl?.type === 'FunctionDeclaration' && decl.id
        ? [[decl.id.name, 'function']]
        : decl?.type === 'ClassDeclaration' && decl.id
          ? [[decl.id.name, 'class']]
          : decl?.type === 'VariableDeclaration'
            ? decl.declarations
                .filter((/** @type {any} */ d) => d.id?.type === 'Identifier')
                .map((/** @type {any} */ d) => [d.id.name, decl.kind])
            : [];
    for (const [name, kind] of names) {
      declared.set(name, kind);
      if (st.type === 'ExportNamedDeclaration') exported.set(name, { local: name });
    }
  }
  return { program, imports, deps, declared, exported };
}

/** The local names a statement reads while its module loads: every reference outside a function body. */
export function loadTimeReads(/** @type {any} */ statement, /** @type {Set<string>} */ names) {
  /** @type {Set<string>} */
  const out = new Set();
  const walk = (/** @type {any} */ node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (DEFERRED.has(node.type)) return;
    if (node.type === 'Identifier' && names.has(node.name)) out.add(node.name);
    for (const [key, value] of Object.entries(node)) if (key !== 'type' && value && typeof value === 'object') walk(value);
  };
  if (statement.type === 'ImportDeclaration' || statement.type === 'FunctionDeclaration') return out;
  const body =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
  // a re-export (`export { a } from`) and a function or type declaration read nothing at load
  if (!body || body.type === 'FunctionDeclaration' || body.type?.startsWith('TS')) return out;
  walk(body);
  return out;
}

/**
 * Every load-order hazard among `files`: a top-level read of a binding imported from a module in the reader's own import
 * cycle, unless that binding is a function declaration.
 * @param {string[]} files repository paths
 * @returns {Hazard[]}
 */
export function hazardsIn(files, repoRoot = root, read = (/** @type {string} */ f) => readFileSync(path.join(repoRoot, f), 'utf8')) {
  /** @type {Map<string, ReturnType<typeof moduleFacts>>} */
  const facts = new Map();
  const factsOf = (/** @type {string} */ f) => {
    if (!facts.has(f)) facts.set(f, moduleFacts(f, read(f), repoRoot));
    return /** @type {ReturnType<typeof moduleFacts>} */ (facts.get(f));
  };
  const graph = new Map(files.map((f) => [f, factsOf(f).deps]));
  /** @type {Map<string, number>} */
  const cycleOf = new Map();
  for (const [i, group] of cyclesOf(graph).entries()) for (const f of group) cycleOf.set(f, i);
  /**
   * What `name` exported from `file` is declared as, and the module that declares it, following re-exports: a binding
   * re-exported from outside the cycle is initialized before the cycle runs.
   * @returns {{ kind: string, home: string }}
   */
  const bindingOf = (/** @type {string} */ file, /** @type {string} */ name, seen = new Set()) => {
    if (seen.has(`${file}:${name}`) || !graph.has(file)) return { kind: 'unknown', home: file };
    seen.add(`${file}:${name}`);
    const f = factsOf(file);
    const origin = f.exported.get(name);
    if (!origin) return { kind: 'unknown', home: file };
    if ('local' in origin) {
      const imported = f.imports.get(origin.local);
      return imported ? bindingOf(imported.from, imported.name, seen) : { kind: f.declared.get(origin.local) ?? 'unknown', home: file };
    }
    return bindingOf(origin.from, origin.name, seen);
  };
  /** @type {Hazard[]} */
  const hazards = [];
  for (const file of files) {
    const cycle = cycleOf.get(file);
    if (cycle === undefined) continue;
    const f = factsOf(file);
    const cyclic = new Set([...f.imports].filter(([, { from }]) => cycleOf.get(from) === cycle).map(([local]) => local));
    if (!cyclic.size) continue;
    const read = new Set(f.program.body.flatMap((/** @type {any} */ st) => [...loadTimeReads(st, cyclic)]));
    for (const local of read) {
      const { from, name } = /** @type {{ from: string, name: string }} */ (f.imports.get(local));
      const { kind, home } = bindingOf(from, name);
      if (kind !== 'function' && cycleOf.get(home) === cycle) hazards.push({ file, name: local, from, imported: name, kind });
    }
  }
  return hazards.sort((a, b) => `${a.file}:${a.name}`.localeCompare(`${b.file}:${b.name}`));
}

/** The app's code files the check covers: the renderer and the modules it shares with main. */
export const appFiles = (repoRoot = root) =>
  ['src', 'shared']
    .flatMap((d) => treeFiles(path.join(repoRoot, d), CODE, { skip: (p, dir) => dir && path.basename(p) === 'protocol' }))
    .map((p) => path.relative(repoRoot, p).split(path.sep).join('/'))
    .filter((f) => !f.endsWith('.d.ts'));

export function main(/** @type {string[]} */ _args, { log = console.log, repoRoot = root } = {}) {
  const hazards = hazardsIn(appFiles(repoRoot), repoRoot);
  for (const h of hazards) log(`${h.file}: reads ${h.name} at load, a ${h.kind} from ${h.from} in its own import cycle`);
  return hazards;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = Math.min(1, main(process.argv.slice(2)).length);

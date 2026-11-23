// What a source module imports and exports, read with the oxc parser that Vite builds the app with, for
// tests that stub a component's dependencies by name. A parser, not a regex: multi-line import lists,
// trailing commas, `type` imports, aliases (`a as b`), default and namespace imports, `export *` and
// formatting changes all read the same.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseSync } from 'vite';

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.cjs', '/index.ts', '/index.tsx'];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;

function parse(file: URL) {
  const result = parseSync(file.pathname, readFileSync(file, 'utf8'));
  if (result.errors.length) throw new Error(`${file.pathname}: ${result.errors[0].message}`);
  return result.module;
}

/** The source file an import specifier names, with its extension (the app imports without one). */
export function resolveSource(specifier: string, from: URL): URL {
  const base = new URL(specifier, from).href;
  const found = EXTENSIONS.map((ext) => new URL(base + ext)).find((u) => SOURCE.test(u.pathname) && existsSync(u));
  if (!found) throw new Error(`${from.pathname}: cannot resolve ${specifier}`);
  return found;
}

/** The value names a module exports (`default` for its default export); type-only exports are left out. */
export function sourceExports(file: URL): string[] {
  const names = new Set<string>();
  for (const statement of parse(file).staticExports)
    for (const entry of statement.entries) {
      if (entry.isType) continue;
      if (entry.exportName.kind === 'Default') names.add('default');
      else if (entry.exportName.name) names.add(entry.exportName.name);
      // export * from './x' or from a package: everything it exports except its default
      else if (entry.moduleRequest) {
        const specifier = entry.moduleRequest.value;
        const all = specifier.startsWith('.')
          ? sourceExports(resolveSource(specifier, file))
          : Object.keys(createRequire(file)(specifier)).filter((n) => n !== '__esModule');
        for (const name of all) if (name !== 'default') names.add(name);
      }
    }
  return [...names];
}

/**
 * Where each of a module's re-exported value names comes from (`export { a, b as c } from './x'`): the module it names
 * and the name it has there. Names a module defines itself, and type-only re-exports, are left out.
 */
export function reexportsOf(file: URL): Map<string, { module: URL; name: string }> {
  const out = new Map<string, { module: URL; name: string }>();
  for (const statement of parse(file).staticExports)
    for (const entry of statement.entries) {
      const specifier = entry.moduleRequest?.value;
      if (entry.isType || !specifier?.startsWith('.') || !entry.exportName.name || !entry.importName.name) continue;
      out.set(entry.exportName.name, { module: resolveSource(specifier, file), name: entry.importName.name });
    }
  return out;
}

/**
 * The value imports of a module: each specifier with the export names it takes from it (`default` for a
 * default import; every export for a namespace import). Type-only imports and side-effect imports are
 * left out.
 */
export function sourceImports(file: URL): { specifier: string; names: string[] }[] {
  const imports: { specifier: string; names: string[] }[] = [];
  for (const statement of parse(file).staticImports) {
    const specifier = statement.moduleRequest.value;
    const names = new Set<string>();
    for (const entry of statement.entries) {
      if (entry.isType) continue;
      if (entry.importName.kind === 'Default') names.add('default');
      else if (entry.importName.kind === 'NamespaceObject') for (const n of sourceExports(resolveSource(specifier, file))) names.add(n);
      else if (entry.importName.name) names.add(entry.importName.name);
    }
    if (names.size) imports.push({ specifier, names: [...names] });
  }
  return imports;
}

/**
 * The relative modules `files` import, other than `files` themselves and those `keep` accepts, each with
 * every name any of them imports from it: what to stub so only `files` (and the kept modules) run for real.
 */
export function importsToStub(files: URL[], keep: (module: URL) => boolean = () => false): Map<string, Set<string>> {
  const own = new Set(files.map((f) => f.href));
  const stubs = new Map<string, Set<string>>();
  for (const file of files)
    for (const { specifier, names } of sourceImports(file)) {
      if (!specifier.startsWith('.')) continue;
      const module = resolveSource(specifier, file);
      if (own.has(module.href) || keep(module)) continue;
      const set = stubs.get(module.href) ?? new Set<string>();
      for (const n of names) set.add(n);
      stubs.set(module.href, set);
    }
  return stubs;
}

/** Keep shared chat visibility and selection contracts real instead of synthesizing inert export stubs. */
export function importsToStubWithChatVisibility(files: URL[]): Map<string, Set<string>> {
  return importsToStub(files, (module) =>
    /\/(?:store\/(deletionVisibility|useDeletionVisibility)|lib\/chatSearch)\.ts$/.test(module.pathname),
  );
}

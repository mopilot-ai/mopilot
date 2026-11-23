// Metro bundles the phone app from mobile/ but resolves node_modules only from mobile/node_modules
// (mobile/metro.config.js), so a bare import in any shared/ file the phone reaches that mobile/package.json does not
// declare fails the iOS/Android release archive with "Unable to resolve module" (build 1: mdast-util-from-markdown,
// declared only in the root package.json, reached through shared/markdownProse.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

const ROOT = resolve('.');
const ENTRIES = ['mobile/index.js', 'mobile/App.tsx'];
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js'];
const IMPORT =
  /(?:^|[;\s])(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The package name a bare specifier installs from (`@scope/name/sub` is `@scope/name`). */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The runtime (non-type-only) module specifiers a source file imports. */
export function runtimeSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(IMPORT)].filter((m) => !m[1]).map((m) => m[2] ?? m[3]);
}

function resolveFile(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return EXTENSIONS.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile());
}

/** Every file reachable from the phone entries through relative imports, with its bare package imports. */
export function phoneReachable(entries = ENTRIES) {
  const files = new Map<string, string[]>();
  const queue = entries.map((e) => resolve(ROOT, e)).filter(existsSync);
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    const bare: string[] = [];
    files.set(file, bare);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const next = resolveFile(file, spec);
        if (next) queue.push(next);
      } else bare.push(spec);
    }
  }
  return files;
}

const mobilePkg = JSON.parse(readFileSync('mobile/package.json', 'utf8'));
const declared = new Set(Object.keys({ ...mobilePkg.dependencies, ...mobilePkg.devDependencies }));
const builtins = new Set(builtinModules);
const isBuiltin = (spec: string) => spec.startsWith('node:') || builtins.has(packageName(spec));

/** Bare imports of phone-reachable files whose package is not in `have`. */
export function undeclaredImports(have: Set<string>): string[] {
  const missing: string[] = [];
  for (const [file, specs] of phoneReachable()) {
    for (const spec of specs) {
      if (!isBuiltin(spec) && !have.has(packageName(spec))) missing.push(`${relative(ROOT, file)} imports ${spec}`);
    }
  }
  return missing;
}

test('the phone bundle reaches shared/ files', () => {
  const rel = [...phoneReachable().keys()].map((f) => relative(ROOT, f));
  assert.ok(rel.some((f) => f.startsWith('shared/remote/')));
  assert.ok(rel.includes('shared/markdownProse.mjs'));
});

test('every bare import in a phone-reachable file is declared in mobile/package.json', () => {
  assert.deepEqual(undeclaredImports(declared), []);
});

test('no phone-reachable shared/ file imports a Node built-in or electron', () => {
  const bad: string[] = [];
  for (const [file, specs] of phoneReachable()) {
    if (!relative(ROOT, file).startsWith('shared/')) continue;
    for (const spec of specs) if (isBuiltin(spec) || packageName(spec) === 'electron') bad.push(`${relative(ROOT, file)} imports ${spec}`);
  }
  assert.deepEqual(bad, []);
});

test('the import scanner skips type-only imports and comments, and names scoped packages', () => {
  const src =
    "import type { A } from 'types-only';\n// import x from 'commented';\nimport { b } from '@s/pkg/sub';\nexport * from 'reexp';\nconst c = await import('dyn');\nconst d = require('req');";
  assert.deepEqual(runtimeSpecifiers(src), ['@s/pkg/sub', 'reexp', 'dyn', 'req']);
  assert.equal(packageName('@s/pkg/sub'), '@s/pkg');
  assert.equal(packageName('a/b'), 'a');
});

test('the pre-fix dependency list is reported', () => {
  const without = new Set(declared);
  without.delete('mdast-util-from-markdown');
  // the one parser the phone's Markdown renderer and the prose helper both read through imports it
  assert.deepEqual(undeclaredImports(without).sort(), ['shared/markdownParse.mjs imports mdast-util-from-markdown']);
});

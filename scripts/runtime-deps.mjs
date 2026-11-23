// The npm packages and repository folders the main process loads at run time, and the checks that keep them in the
// packaged app: electron/, shared/ and host/src ship as plain files in app.asar and require from its node_modules,
// which the packager prunes of devDependencies (scripts/package.mjs), so a package they load must be a production
// dependency and must still be in the pruned build; app.asar holds only the top-level entries in SHIPPED, so a
// relative load must stay inside them. tests/packagedDependencies.test.ts runs both repository checks on every change.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The folders that ship as plain files in app.asar (the renderer is a vite bundle and needs no node_modules). */
export const RUNTIME_DIRS = ['electron', 'shared', 'host/src'];
/**
 * The repository's top-level entries app.asar holds, including the source edition's license and notice.
 * Bundling those notices inside app.asar leaves Electron's own LICENSE beside the archive on macOS.
 * scripts/package.mjs leaves every other one out (the Rust core's build output in core/target, bench, lint, dot folders).
 */
export const SHIPPED = ['dist', 'electron', 'host', 'node_modules', 'package.json', 'shared', 'LICENSE', 'NOTICE'];

const SCRIPT = /\.[cm]?js$/;
// import x from '…', import '…', export … from '…', import('…'), require('…'), require.resolve('…')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)['"]([^'"\s]+)['"]/g;
// an npm package name (optionally scoped) and an optional subpath
const PACKAGE = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:\/|$)/;

/** The package a specifier names, or null for relative paths, node builtins and Electron itself. */
export function packageOf(/** @type {string} */ specifier) {
  const name = PACKAGE.exec(specifier)?.[1];
  return !name || builtinModules.includes(name) || name === 'electron' ? null : name;
}

// whole comment lines (// …, and the * lines of a JSDoc block, where `import('pkg')` names a type), not code
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*).*$/gm;

/** Every package `text` loads, in order. */
export const packagesIn = (/** @type {string} */ text) =>
  [...text.replace(COMMENT_LINE, '').matchAll(SPECIFIER)].map((m) => packageOf(m[1])).filter((name) => name !== null);

/** The repository's runtime scripts under `dir`, as repository paths. */
const runtimeFiles = (/** @type {string} */ root, /** @type {string} */ dir) =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : runtimeFiles(root, rel);
    return SCRIPT.test(entry.name) ? [rel] : [];
  });

/** Each package the runtime folders load, with the files that load it. */
export function runtimePackages(root = ROOT) {
  /** @type {Map<string, string[]>} */
  const users = new Map();
  for (const file of RUNTIME_DIRS.flatMap((dir) => runtimeFiles(root, dir))) {
    for (const name of new Set(packagesIn(readFileSync(path.join(root, file), 'utf8')))) {
      users.set(name, [...(users.get(name) ?? []), file]);
    }
  }
  return users;
}

/**
 * The packages the runtime folders load, sorted. Throws when one is not in package.json's `dependencies`: the
 * packaged app would fail on launch with "Cannot find module".
 */
export function checkRuntimeDependencies(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const production = new Set(Object.keys(pkg.dependencies ?? {}));
  const users = runtimePackages(root);
  const devOnly = [...users].filter(([name]) => !production.has(name)).map(([name, files]) => `${name} (${files.join(', ')})`);
  if (devOnly.length)
    throw new Error(`Move to "dependencies" in package.json; the packaged app prunes devDependencies: ${devOnly.join('; ')}`);
  return [...users.keys()].sort();
}

/** Every relative specifier `text` loads, in order. */
const relativeIn = (/** @type {string} */ text) =>
  [...text.replace(COMMENT_LINE, '').matchAll(SPECIFIER)].map((m) => m[1]).filter((s) => s.startsWith('.'));

/**
 * The runtime files' relative loads that leave SHIPPED, as `file -> specifier`: the packaged app would fail with
 * "Cannot find module" where a checkout runs.
 */
export function unshippedLoads(root = ROOT) {
  const shipped = new Set(SHIPPED);
  return RUNTIME_DIRS.flatMap((dir) => runtimeFiles(root, dir)).flatMap((file) =>
    relativeIn(readFileSync(path.join(root, file), 'utf8'))
      .filter((spec) => !shipped.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).split('/')[0]))
      .map((spec) => `${file} -> ${spec}`),
  );
}

/** The packages missing from a pruned app folder (packager's buildPath), as names. */
export const missingFromBuild = (
  /** @type {string} */ buildPath,
  /** @type {Iterable<string>} */ names,
  /** @type {(file: string) => boolean} */ exists = existsSync,
) => [...names].filter((name) => !exists(path.join(buildPath, 'node_modules', name, 'package.json')));

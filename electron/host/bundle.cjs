// The Host as one tarball per platform: the files `host/bin/mopilot-host.mjs` reaches (found by reading its imports), the npm packages those need, a root shim in the format `mopilot-host update` unpacks, that platform's Rust core, and a manifest with the archive's SHA-256. Bytes are deterministic, so the same tree always has the same checksum.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const nodeModule = require('node:module');
const { builtinModules } = nodeModule;
const { writeAtomic } = require('../platform/fsutil.cjs');
const { checkoutCore, inPackagedApp, sha256Of } = require('../platform/core.cjs');
const { HOST_CORE_ADDON, HOST_CORE_DIR, HOST_CORE_RECORD, coreBuildHere } = require('../../shared/host/coreBuild.mjs');

const ENTRY = 'host/bin/mopilot-host.mjs';
/** Where an archive records its build id (host/src/status.mjs reads it). */
const BUILD_ID_FILE = 'host/BUILD_ID';
/** The version of the app that built the archive, which the Host reports so an app can tell an older Host from a newer one (a build id is a hash and has no order). */
const APP_VERSION_FILE = 'host/APP_VERSION';
/** A string literal naming a file next to the one that reads it (the keywords count only as code: a `'from'` inside a list of strings is not an import): an import (with or without bindings), a require (also `createRequire(import.meta.url)('…')`), an `import()` or `new URL(…, import.meta.url)`. */
const REFERENCE =
  /(?:(?<![\w'"`.])from\s*|(?<![\w'"`.])import\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|import\.meta\.url\s*\)\s*\(\s*|new URL\(\s*)['"]([^'"]+)['"]/g;
/** A call whose file name is built from a variable (`req(`./${id}.cjs`)`): the static scan cannot name the file, so it takes every file that fits the template (group 1 the text before the variable, group 2 the text after the last one). */
const TEMPLATE_REFERENCE = /\(\s*`(\.[^`$]*)\$\{[^`]*?\}([^`$}]*)`\s*[,)]/g;
/** A private module loaded where the build has it (electron/platform/optionalPrivate.cjs), named as one path next to the code. */
const OPTIONAL_PRIVATE = /optionalPrivate\(\s*path\.join\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g;
/** A file read next to the code that reads it, named as `path.join(__dirname, 'file')` (a prompt or patch the module loads when it starts). */
const DIRNAME_REFERENCE = /__dirname\s*,\s*['"]([^'"]+)['"]/g;
/** What of a package the Host can run: code and metadata, not its tests, docs or type declarations. */
const PACKAGE_FILE = /\.(?:js|mjs|cjs|json)$|^LICENSE/i;
const SKIP_DIR = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github']);
/** Modules the Host has where it runs, or does without when absent (the Electron API is imported only behind a check). */
const PROVIDED = new Set(['electron', ...builtinModules]);
/** What the unpacked tree's root offers `mopilot-host update`: its `src/cli.mjs`, which the Host started from a staged version runs. */
const ROOT_SHIM = {
  path: 'src/cli.mjs',
  text: "// The root of an unpacked Host version, in the shape `mopilot-host update` runs.\nexport { main } from '../host/src/cli.mjs';\n",
};

/** Where a package records the hashes of the Host builds it carries, relative to the app's root (scripts/package.mjs). */
const HOST_CORE_HASH_FILE = 'electron/host/host-core-hashes.json';

/** The package a bare specifier names (`@scope/name/sub` is `@scope/name`). @param {string} spec */
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** The folder of `name` as `from` would find it, searching each parent's node_modules; null when there is none. @param {string} name @param {string} from */
function findPackage(name, from) {
  // up to the filesystem root, whose parent is itself
  for (let dir = from, parent = ''; dir !== parent; parent = dir, dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** Every file of a package the Host can run, as paths relative to `root`. @param {string} dir @param {string} root @param {string[]} out */
function packageFiles(dir, root, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || SKIP_DIR.has(e.name)) continue;
      packageFiles(full, root, out);
    } else if (e.isFile() && PACKAGE_FILE.test(e.name)) out.push(path.relative(root, full));
  }
}

/**
 * Every file the Host needs, as sorted `/`-separated paths relative to `root`: the code reached from the executable by relative imports, each npm package those import and the packages theirs depend on.
 * A reference that names a file that is not there is an error, never a gap in the archive.
 * @param {string} root the repository (or app) root
 * @returns {string[]}
 */
function hostFiles(root) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Set<string>} package folders, absolute */
  const packages = new Set();
  /** @param {string} file absolute */
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    // comments that begin a line are not code: a JSDoc type like import('../x').T names a file only for the type checker
    const src = fs
      .readFileSync(file, 'utf8')
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of src.matchAll(TEMPLATE_REFERENCE)) {
      const [, before, after] = m;
      const dir = path.resolve(path.dirname(file), path.dirname(`${before}x`));
      const stem = path.basename(`${before}x`).slice(0, -1);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).sort())
        if (name.startsWith(stem) && name.endsWith(after) && /\.(?:mjs|cjs|js)$/.test(name) && fs.statSync(path.join(dir, name)).isFile())
          walk(path.join(dir, name));
    }
    // taken with what it needs where this checkout has it (a private build); the open-source edition has none to take
    for (const m of src.matchAll(OPTIONAL_PRIVATE)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(target)) walk(target);
    }
    for (const m of src.matchAll(DIRNAME_REFERENCE)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) files.add(target);
    }
    for (const m of src.matchAll(REFERENCE)) {
      const spec = m[1];
      // a real specifier has no whitespace: text between two quotes that follows the word `from` in prose or a string is not an import
      if (/\s/.test(spec)) continue;
      // a type declaration file (`import('./x.d.mts').T` in an inline JSDoc type) is read by the type checker only, and the packager leaves it out
      if (/\.d\.[cm]?ts$/.test(spec)) continue;
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile())
          throw new Error(`${path.relative(root, file)} reads ${spec}, which is not there.`);
        if (/\.(?:mjs|cjs|js|ts)$/.test(target)) walk(target);
        else files.add(target);
      } else if (!PROVIDED.has(spec.replace(/^node:/, '')) && !spec.startsWith('node:')) {
        const name = packageName(spec);
        const dir = findPackage(name, path.dirname(file));
        if (!dir) throw new Error(`${path.relative(root, file)} needs the package ${name}, which is not installed.`);
        addPackage(dir);
      }
    }
  };
  /** @param {string} dir */
  const addPackage = (dir) => {
    if (packages.has(dir)) return;
    packages.add(dir);
    const listed = /** @type {string[]} */ ([]);
    packageFiles(dir, root, listed);
    for (const rel of listed) files.add(path.join(root, rel));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const found = findPackage(dep, dir);
      if (!found) throw new Error(`The package ${pkg.name} needs ${dep}, which is not installed.`);
      addPackage(found);
    }
  };
  walk(path.join(root, ENTRY));
  return [...files].map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
}

/** One ustar header for a regular file: the checksum filled in last. @param {string} name @param {number} size */
function header(name, size) {
  const block = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // split at a `/` so that the folder fits the prefix field and the rest the name field
    const cut = [...name.matchAll(/\//g)]
      .map((m) => /** @type {number} */ (m.index))
      .find((i) => i <= 155 && Buffer.byteLength(name) - i - 1 <= 100);
    if (cut === undefined) throw new Error(`The path ${name} is too long for a tar archive.`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (/** @type {string} */ text, /** @type {number} */ at, /** @type {number} */ len) => block.write(text, at, len, 'utf8');
  const octal = (/** @type {number} */ n, /** @type {number} */ len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(base, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  // a fixed time: the same files are the same bytes
  put(octal(0, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  put(
    `${block
      .reduce((sum, b) => sum + b, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  );
  return block;
}

/** `entries` as ustar records, in the order given, with no end of archive. @param {{ path: string, data: Buffer }[]} entries */
function tarRecords(entries) {
  const parts = [];
  for (const { path: name, data } of entries) {
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat(parts);
}

/** Node writes a zero modification time into the gzip header, so the bytes depend on the files alone. @param {Buffer} bytes */
const gzip = (bytes) => zlib.gzipSync(bytes, { level: 9 });
const END_OF_ARCHIVE = Buffer.alloc(1024);

/** A gzip'd ustar archive of `entries` (path and bytes), in the order given. @param {{ path: string, data: Buffer }[]} entries */
const tarball = (entries) => gzip(Buffer.concat([tarRecords(entries), END_OF_ARCHIVE]));

/**
 * The compressed part every platform's archive starts with: what follows it is one more gzip member (`tar -xz` reads them as one stream), so Add by command, which needs the checksum of every build at once, compresses the Host one time and not six.
 * @param {string} root
 */
function hostPart(root) {
  const code = hostEntries(root);
  // the Host reads this file to say which build it runs (status.build); the app compares it with its own to see an older Host
  const buildId = buildIdOf(code);
  const entries = [
    ...code,
    { path: BUILD_ID_FILE, data: Buffer.from(`${buildId}\n`) },
    { path: APP_VERSION_FILE, data: Buffer.from(`${appHostVersion(root)}\n`) },
  ];
  return { bytes: gzip(tarRecords(entries)), files: entries.length, buildId };
}

/** The files every archive carries, before the build id: the root shim and what the Host reaches. @param {string} root */
const hostEntries = (root) => [
  { path: ROOT_SHIM.path, data: Buffer.from(ROOT_SHIM.text) },
  ...hostFiles(root).map((p) => shipped(p, fs.readFileSync(path.join(root, p)))),
];

/**
 * What the Host runs from a source file. The Host runs plain JavaScript on the machine's own Node (22 or newer, some of which cannot run
 * TypeScript at all), so a `.ts` file ships as `.mjs` with its types stripped (Node's own `stripTypeScriptTypes`, which refuses what
 * is not just types: enums, namespaces, parameter properties), and every relative `.ts` specifier of the shipped code names that `.mjs`.
 * @param {string} rel the file's path in the repository @param {Buffer} data
 * @returns {{ path: string, data: Buffer }}
 */
function shipped(rel, data) {
  if (!/\.(?:mjs|cjs|js|ts)$/.test(rel)) return { path: rel, data };
  let text = data.toString('utf8');
  const typed = rel.endsWith('.ts');
  if (typed) {
    if (typeof nodeModule.stripTypeScriptTypes !== 'function')
      throw new Error(
        `${rel} is TypeScript, and this Node (${process.version}) cannot strip its types; building a Host needs Node 22.13 or newer.`,
      );
    try {
      text = nodeModule.stripTypeScriptTypes(text, { mode: 'strip' });
    } catch (error) {
      throw new Error(`${rel} uses TypeScript that is more than types, which a Host cannot run: ${/** @type {Error} */ (error).message}`);
    }
  }
  text = text.replace(REFERENCE, (whole, spec) =>
    spec.startsWith('.') && spec.endsWith('.ts') && !/\.d\.[cm]?ts$/.test(spec) ? whole.replace(spec, `${spec.slice(0, -3)}.mjs`) : whole,
  );
  return { path: typed ? `${rel.slice(0, -3)}.mjs` : rel, data: Buffer.from(text) };
}

/** The build a set of Host files makes: a hash of every path and content, so two apps with the same Host code have the same id whatever their version says. @param {{ path: string, data: Buffer }[]} entries */
const buildIdOf = (entries) =>
  crypto
    .createHash('sha256')
    .update(entries.map((e) => `${e.path}\0${crypto.createHash('sha256').update(e.data).digest('hex')}\n`).join(''))
    .digest('hex')
    .slice(0, 16);

/** The build id of the Host this app carries ('' when its files cannot be listed, as in a checkout without the Host's packages). @param {string} root */
function appHostBuild(root) {
  try {
    return buildIdOf(hostEntries(root));
  } catch {
    return '';
  }
}

/** The version of the app at `root` ('' when it cannot be read): what its Host archives record, and what a Host's own is compared with. @param {string} root */
function appHostVersion(root) {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof version === 'string' ? version : '';
  } catch {
    return '';
  }
}

/** The folder holding the Host's builds of the core: the app's resources when packaged, the release's vendor folder in a checkout. @param {string} root */
const hostCoreRoot = (root) =>
  inPackagedApp(root) ? path.join(process.resourcesPath ?? '', HOST_CORE_DIR) : path.join(root, 'build', 'vendor', HOST_CORE_DIR);

/** The hashes a package recorded of the builds it carries (scripts/package.mjs), in app.asar with this file, or null when it carries none. @param {string} root @returns {Record<string, string> | null} */
function recordedCores(root) {
  const file = path.join(root, HOST_CORE_HASH_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * What `build`'s archive carries of the core, with no end of archive: a Host does not start without it. A package that records its builds must hold this one, unchanged: those files are outside app.asar, and what is sent here runs on someone's machine. An app with no record (a checkout, a developer's package) sends what it has, and for this machine's own build a checkout's addon serves.
 * @param {string} build @param {string} coreRoot @param {string} root @returns {{ path: string, data: Buffer }[]}
 */
function coreEntries(build, coreRoot, root) {
  const vendored = path.join(coreRoot, build, HOST_CORE_ADDON);
  const recorded = recordedCores(root);
  const own = !recorded && !fs.existsSync(vendored) && build === coreBuildHere() ? checkoutCore(root) : null;
  const file = own ?? vendored;
  if (!fs.existsSync(file)) {
    if (recorded) throw new Error(`This app carries no Host build for ${build}.`);
    throw new Error(
      `There is no Host build for ${build}: make one with node scripts/build-core.mjs --host ${build} --out build/vendor/host-core.`,
    );
  }
  const sha256 = sha256Of(file);
  if (recorded && recorded[build] !== sha256) throw new Error(`The Host build for ${build} is not the one this app was packaged with.`);
  return [
    { path: `${HOST_CORE_DIR}/${HOST_CORE_RECORD}`, data: Buffer.from(`${JSON.stringify({ build, sha256 })}\n`) },
    { path: `${HOST_CORE_DIR}/${HOST_CORE_ADDON}`, data: fs.readFileSync(file) },
  ];
}

/**
 * Build the Host archive of one platform and its manifest into `outDir` (`host-<version>-<sha>.tgz` and `manifest.json`, `{ version, sha256, url }` in the format `mopilot-host update --manifest` reads), in a folder of its own for a `build`, where the manifest also names it. With no `build` the archive carries no core.
 * The manifest is unsigned: a Host takes an update only from a manifest the app signed for it (electron/host/hostUpdate.cjs). That signature covers `sha256`, this archive's, so it covers the addon inside.
 * @param {{ root: string, outDir: string, build?: string | null, coreRoot?: string, part?: ReturnType<typeof hostPart> }} o
 * @returns {{ file: string, manifest: string, sha256: string, version: string, files: number, core: string | null, buildId: string }}
 */
function buildBundle({ root, outDir, build = null, coreRoot = hostCoreRoot(root), part = hostPart(root) }) {
  const core = build ? coreEntries(build, coreRoot, root) : [];
  const bytes = Buffer.concat([part.bytes, gzip(Buffer.concat([tarRecords(core), END_OF_ARCHIVE]))]);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'host/package.json'), 'utf8'));
  const dir = build ? path.join(outDir, build) : outDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `host-${version}-${sha256.slice(0, 12)}.tgz`;
  const file = path.join(dir, name);
  writeAtomic(file, bytes, fs, 0o600);
  const manifest = path.join(dir, 'manifest.json');
  const carried = core.length > 0 ? build : null;
  const facts = { version, sha256, url: name, ...(carried && { build: carried }) };
  writeAtomic(manifest, `${JSON.stringify(facts, null, 2)}\n`, fs, 0o600);
  return { file, manifest, sha256, version, files: part.files + core.length, core: carried, buildId: part.buildId };
}

/** Each tarball is a pure function of the app's files, so one build serves every install of an app run: the first call for a platform builds it, later calls get the same result. @param {Parameters<typeof buildBundle>[0]} o */
function bundleOnce(o) {
  /** @type {Map<string | null, ReturnType<typeof buildBundle>>} */
  const built = new Map();
  /** @type {ReturnType<typeof hostPart> | null} */
  let part = null;
  return (/** @type {string | null} */ build = null) => {
    const found = built.get(build);
    if (found) return found;
    const made = buildBundle({ ...o, build, part: (part ??= hostPart(o.root)) });
    built.set(build, made);
    return made;
  };
}

module.exports = {
  buildBundle,
  bundleOnce,
  hostFiles,
  hostEntries,
  shipped,
  tarball,
  appHostBuild,
  appHostVersion,
  ENTRY,
  HOST_CORE_HASH_FILE,
};

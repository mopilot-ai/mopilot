// The Rust core's coverage (docs/architecture/rust-core.md §9): its tests under `cargo llvm-cov` with branch coverage on
// the pinned nightly, and the lcov that writes read into the per-file shape c8's report has, so the changed-line check
// (scripts/diff-coverage.mjs) holds .rs files to the same 100% as JS. Code built only on one OS is measured there: the
// reports of each OS's run are merged before the check.
//
//   node scripts/rust-coverage.mjs --out <file.lcov>   (run the core's tests and write their lcov)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
/** @typedef {(cmd: string, args: string[], cwd: string, env?: Record<string, string>) => { status: number | null, error?: Error }} Run */
/** Branch coverage needs `-Zcoverage-options=branch`, so only the coverage run pins a nightly (with llvm-tools-preview). */
export const NIGHTLY = 'nightly-2026-10-20';

/** A Rust source of the core, which the changed-line check measures. Repository-relative, '/'-separated. */
export const isCoreSource = (/** @type {string} */ rel) => /^core\/crates\/[^/]+\/(?:src|tests)\/.+\.rs$/.test(rel);
/** A change under core/ (sources, manifests, the lockfile, the toolchain): the core's tests and coverage run for it. */
export const isCoreChange = (/** @type {string} */ rel) => rel.startsWith('core/') && !rel.startsWith('core/target/');

/**
 * The lcov `text` as c8's per-file entries, keyed by absolute path under `repoRoot`. A source path is taken from its
 * `core/` part on, since each runner checks the repository out somewhere else.
 * @returns {Record<string, any>}
 */
export function lcovToCoverage(text, repoRoot = root) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {any} */
  let entry = null;
  /** @type {Map<string, number>} */
  let fnIds = new Map();
  /** @type {Map<number, number>} */
  let fnLines = new Map();
  /** @type {Map<string, number>} */
  let branchIds = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const [tag, value] = colon < 0 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1)];
    if (tag === 'SF') {
      const at = value.replaceAll('\\', '/').lastIndexOf('/core/');
      const rel = at < 0 ? null : value.replaceAll('\\', '/').slice(at + 1);
      const abs = rel ? path.join(repoRoot, rel) : value;
      entry = out[abs] ??= { path: abs, statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} };
      // a function is one per source line: each binary (the test binary, the addon) lists its own copy under another
      // mangled name, and a copy that one binary never calls must not read as unrun when another did run it
      fnLines = new Map(Object.entries(entry.fnMap).map(([id, fn]) => [fn.loc.start.line, Number(id)]));
      fnIds = new Map();
      branchIds = new Map(Object.entries(entry.branchMap).map(([id, br]) => [br.key, Number(id)]));
    } else if (tag === 'end_of_record') {
      entry = null;
    } else if (entry && tag === 'DA') {
      const [ln, hits] = value.split(',').map(Number);
      const loc = { start: { line: ln, column: 0 }, end: { line: ln, column: 0 } };
      entry.statementMap[ln] ??= loc;
      entry.s[ln] = (entry.s[ln] ?? 0) + hits;
    } else if (entry && tag === 'FN') {
      // FN:<start>,<name>, or FN:<start>,<end>,<name> in newer lcov
      const parts = value.split(',');
      const start = Number(parts[0]);
      const end = parts.length > 2 ? Number(parts[1]) : start;
      const name = parts.slice(parts.length > 2 ? 2 : 1).join(',');
      let id = fnLines.get(start);
      if (id === undefined) {
        id = Object.keys(entry.fnMap).length;
        fnLines.set(start, id);
        entry.fnMap[id] = { name, loc: { start: { line: start, column: 0 }, end: { line: end, column: 0 } } };
        entry.f[id] = 0;
      }
      fnIds.set(name, id);
    } else if (entry && tag === 'FNDA') {
      const comma = value.indexOf(',');
      const id = fnIds.get(value.slice(comma + 1));
      if (id !== undefined) entry.f[id] += Number(value.slice(0, comma));
    } else if (entry && tag === 'BRDA') {
      const [ln, block, branch, taken] = value.split(',');
      const key = `${ln}:${block}`;
      if (!branchIds.has(key)) {
        const id = Object.keys(entry.branchMap).length;
        branchIds.set(key, id);
        entry.branchMap[id] = { key, loc: { start: { line: Number(ln), column: 0 }, end: { line: Number(ln), column: 0 } }, locations: [] };
        entry.b[id] = [];
      }
      const id = /** @type {number} */ (branchIds.get(key));
      const index = Number(branch);
      const loc = entry.branchMap[id].loc;
      entry.branchMap[id].locations[index] = loc;
      entry.b[id][index] = (entry.b[id][index] ?? 0) + (taken === '-' ? 0 : Number(taken));
    }
  }
  return out;
}

/**
 * The lcov reports merged into c8's report `base`. One file's sections from several reports (each OS's run) add up, since
 * the reader joins repeated sections of a file; c8 never holds a .rs file, so nothing of `base` is replaced.
 */
export function mergeLcov(base, texts, repoRoot = root) {
  return { ...base, ...lcovToCoverage(texts.join('\n'), repoRoot) };
}

/** The addon's file name as Cargo builds it, per platform (electron/platform/core.cjs reads the same). */
const BUILT = { darwin: 'libmopilot_core.dylib', linux: 'libmopilot_core.so', win32: 'mopilot_core.dll' };
/** The tests that load the built addon, by name, so the binding's own Rust code is measured through JS. */
const BINDING_TESTS = /^coreBinding.*\.test\.ts$/;

/** `export KEY='value'` lines (cargo llvm-cov show-env --export-prefix) as an environment. */
export function parseEnv(/** @type {string} */ text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const m of text.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(\S*))$/gm)) env[m[1]] = m[2] ?? m[3] ?? m[4];
  return env;
}

/**
 * Run the core's tests under coverage and write their lcov to `out`: its Rust tests, then the JS tests that load the
 * addon (tests/coreBinding*.test.ts) against an instrumented build of it, so the binding's code is measured where it
 * runs, then one report of both. Returns the exit status.
 * @param {string} out
 * @param {{ run?: Run, read?: (cmd: string, args: string[], cwd: string) => string, repoRoot?: string, platform?: string, tests?: string[] }} [deps]
 */
export function runRustCoverage(
  out,
  {
    run = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }),
    read = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }),
    repoRoot = root,
    platform = process.platform,
    tests = readdirSync(path.join(repoRoot, 'tests'))
      .filter((f) => BINDING_TESTS.test(f))
      .map((f) => path.join('tests', f)),
  } = {},
) {
  mkdirSync(path.dirname(path.resolve(repoRoot, out)), { recursive: true });
  const core = path.join(repoRoot, 'core');
  const nightly = `+${NIGHTLY}`;
  let env;
  try {
    env = parseEnv(read('cargo', [nightly, 'llvm-cov', 'show-env', '--branch', '--export-prefix'], core));
  } catch (error) {
    console.error(
      `rust-coverage: cargo llvm-cov did not start (${/** @type {Error} */ (error).message}). Install rustup, then \`rustup toolchain install ${NIGHTLY} --component llvm-tools-preview\` and \`cargo install cargo-llvm-cov\`.`,
    );
    return 1;
  }
  const addon = path.join(
    env.CARGO_LLVM_COV_TARGET_DIR ?? path.join(core, 'target'),
    'debug',
    BUILT[/** @type {keyof typeof BUILT} */ (platform)],
  );
  const steps = [
    ['cargo', [nightly, 'llvm-cov', 'clean', '--workspace'], core, env],
    ['cargo', [nightly, 'test'], core, env],
    // with the routes only the binding's tests call (core/crates/node/src/test_routes.rs)
    ['cargo', [nightly, 'build', '-p', 'node', '--features', 'test-routes'], core, env],
    // Fresh native lanes skip npm prepare; shared package services still need the repository-owned generated catalog.
    [process.execPath, ['scripts/harness-catalog.mjs'], repoRoot, env],
    // the binding's tests need no install (they load only the repository's own modules), and lease their workers from the
    // machine's shared budget like every test run (scripts/test-slots.mjs)
    [
      process.execPath,
      ['scripts/test-slots.mjs', '--test', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...tests],
      repoRoot,
      { ...env, MOPILOT_CORE: addon, MOPILOT_CORE_REQUIRED: '1' },
    ],
    ['cargo', [nightly, 'llvm-cov', 'report', '--branch', '--lcov', '--output-path', path.resolve(repoRoot, out)], core, env],
  ];
  for (const [cmd, args, cwd, stepEnv] of /** @type {[string, string[], string, Record<string, string>][]} */ (steps)) {
    const result = run(cmd, args, cwd, stepEnv);
    if (result.error || result.status !== 0) {
      console.error(
        `rust-coverage: \`${path.basename(cmd)} ${args.join(' ')}\` failed${result.error ? ` (${result.error.message})` : ''}.`,
      );
      return result.status || 1;
    }
  }
  return 0;
}

/**
 * The paths under core/ a change since its merge base with `base` touches, untracked files included.
 * @param {string} base @param {(args: string[]) => string} git
 */
export function coreChanges(base, git) {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const tracked = git(['diff', '--name-only', '--no-renames', mergeBase]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...tracked, ...untracked].filter((f) => f && isCoreChange(f));
}

/**
 * For a change that touches core/: its tests run under coverage and their lcov is returned. Null when the change does
 * not touch core/; the exit status when the run fails.
 * @param {string} base @param {(args: string[]) => string} git @param {string} dir where the lcov is written
 * @param {Parameters<typeof runRustCoverage>[1]} [deps]
 * @returns {string | number | null}
 */
export function changedCoreLcov(base, git, dir, { repoRoot = root, ...deps } = {}) {
  if (!coreChanges(base, git).length) return null;
  const out = path.join(dir, 'rust.lcov');
  const status = runRustCoverage(out, { ...deps, repoRoot });
  return status ? status : readFileSync(path.resolve(repoRoot, out), 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : undefined;
  if (!out) {
    console.error('Usage: node scripts/rust-coverage.mjs --out <file.lcov>');
    process.exitCode = 1;
  } else process.exitCode = runRustCoverage(out);
}

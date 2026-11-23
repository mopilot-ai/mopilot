// Builds native/sage-mcp, the stdio MCP server harnesses launch to reach MoPilot's tools.
//   node scripts/build-sage-mcp.mjs [--out <dir>] [--debug] [--arch arm64|x64] | --ensure (build only if missing or stale)
// Output: native/sage-mcp/build/sage-mcp unless --out is given.
// Signing: ad-hoc with the hardened runtime by default; MOPILOT_SIGN_IDENTITY signs it for release
// scripts/package.mjs builds it unsigned (sign: false) and osx-sign signs it inside MoPilot.app.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwiftProduct, swiftProductCli } from './swift-product.mjs';
import { tryLock } from './pid-lock.mjs';

const PRODUCT = 'sage-mcp';
export const SAGE_MCP_IDENTIFIER = 'ai.mopilot.code.sage-mcp';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'native/sage-mcp');

/** @param {Parameters<typeof buildSwiftProduct>[1]} [o] */
export const buildSageMcp = (o) => buildSwiftProduct({ product: PRODUCT, identifier: SAGE_MCP_IDENTIFIER, pkgDir, linux: true }, o);

export function swiftAvailable(platform = process.platform, run = spawnSync) {
  return (platform === 'darwin' || platform === 'linux') && run('swift', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** The newest modification time of a file, or of anything inside a folder. */
export const newest = (p) =>
  statSync(p).isDirectory() ? Math.max(statSync(p).mtimeMs, ...readdirSync(p).map((f) => newest(path.join(p, f)))) : statSync(p).mtimeMs;
export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The checkout's sage-mcp, built when it is missing or older than native/sage-mcp's sources. Safe to
 * call from several processes at once (node --test runs one per test file): one builds under a lock,
 * the rest wait and then find it current. Returns the path, or null when it can't be built because
 * there is no swift toolchain (with swift available, a failed build throws). Cached per process.
 */
/** @type {ReturnType<typeof ensureBuilt> | null} */
let ensured = null;
export function ensureSageMcp(
  options = {
    /* quiet unless the caller passes a logger */
  },
) {
  if (ensured) return ensured;
  return (ensured = ensureBuilt(options));
}

/**
 * The build lock of a sage-mcp package: a folder beside it, in the checkout whose .build database the lock protects.
 * Never under os.tmpdir(): each test process has its own TMPDIR (#2340), so a lock there serialized nothing and
 * concurrent swift builds corrupted the build database (#2374). Gitignored (.gitignore).
 */
export const buildLockPath = (pkg = pkgDir) => path.join(pkg, '.build.lock.pid');
/** A lock held longer than any build: its builder died and its pid belongs to another process now (the lock outlives a reboot). */
export const STALE_LOCK_MS = 30 * 60 * 1000;

/** ensureSageMcp without the per-process cache; `log` and `maxWaitMs` as there, and its package, files and tools replaceable. */
export function ensureBuilt({
  log = () => {
    /* quiet unless a logger is provided */
  },
  maxWaitMs = 300_000,
  pkg = pkgDir,
  exe = path.join(pkg, 'build', PRODUCT),
  sources = [path.join(pkg, 'Sources'), path.join(pkg, 'Package.swift')],
  lock = buildLockPath(pkg),
  swift = swiftAvailable,
  build = buildSageMcp,
  alive = pidAlive,
  sleep = sleepSync,
  now = Date.now,
} = {}) {
  const current = () => existsSync(exe) && statSync(exe).mtimeMs >= Math.max(...sources.map(newest));
  if (current()) return exe;
  if (!swift()) return existsSync(exe) ? exe : null;
  const start = now();
  // the lock is one file published whole (scripts/pid-lock.mjs): a holder is live while its process exists and it is younger than a build
  let held;
  for (;;) {
    const got = tryLock(lock, { now, live: (owner, ageMs) => alive(owner.pid) && ageMs <= STALE_LOCK_MS });
    if (got.owned) {
      held = got;
      break;
    }
    if (now() - start > maxWaitMs)
      throw new Error(
        `sage-mcp: gave up waiting ${Math.round(maxWaitMs / 1000)}s for the build lock ${lock} (held by pid ${got.owner?.pid || '?'})`,
      );
    sleep(200);
  }
  try {
    if (!current()) build({ log, out: path.dirname(exe) });
  } finally {
    held.release();
  }
  if (!current()) throw new Error(`sage-mcp: the build finished but ${exe} is missing or older than its sources`);
  return exe;
}

/** The command line (see the top of this file); --help prints the usage. */
export function cli(argv, { ensure = ensureSageMcp, build = buildSageMcp, log = console.log, platform = process.platform } = {}) {
  if (argv.includes('--help')) return log('usage: node scripts/build-sage-mcp.mjs [--out <dir>] [--debug] [--arch arm64|x64] | --ensure');
  // Windows' sage-mcp is the Rust one (core/crates/sage-mcp), which the core's --ensure builds beside the addon
  if (argv.includes('--ensure') && platform === 'win32')
    return log("sage-mcp on Windows is the Rust core's: scripts/build-core.mjs --ensure builds it");
  if (argv.includes('--ensure')) {
    // for callers that only need it current (and don't mind a missing swift): exit 0 either way
    const exe = ensure({ log });
    log(exe ? `sage-mcp is current: ${exe}` : 'no swift toolchain: sage-mcp not built');
  } else swiftProductCli(argv, 'scripts/build-sage-mcp.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));

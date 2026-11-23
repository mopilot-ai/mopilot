// Launches a packaged app once, before a release is published, and fails unless it starts: unit tests and E2E run the
// source tree, so only this sees what the shipped artifact lacks (a pruned package, an excluded file).
//   node scripts/smoke-launch.mjs "out/MoPilot-darwin-arm64/MoPilot.app"    macOS
//   node scripts/smoke-launch.mjs "out/MoPilot-win32-x64"                         Windows (the app folder)
// The app runs with scratch user data and in background mode, writes how its startup ended to MOPILOT_SMOKE_RESULT
// (electron/app/smokeLaunch.cjs) and quits: the browser memory guard's worker must have reached the core too. It must report the release's version (RELEASE_VERSION, else package.json's):
// the updater, install pings and telemetry all send app.getVersion(). Release-only: it starts a real app (AGENTS.md).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { requireRelease } = createRequire(import.meta.url)('./release-suites.cjs');

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const TIMEOUT_MS = 120_000;

/**
 * The executable inside a packaged app: the .app bundle's binary on macOS, the .exe in the Windows app folder.
 * @param {string} appPath
 * @param {string} [productName]
 * @param {string} [platform]
 */
export function executableOf(appPath, productName = PKG.productName, platform = process.platform) {
  if (platform === 'linux') return path.join(appPath, 'mopilot');
  return platform === 'win32' ? path.join(appPath, `${productName}.exe`) : path.join(appPath, 'Contents', 'MacOS', productName);
}

/**
 * @typedef {{ productName?: string, platform?: string, timeoutMs?: number, version?: string, env?: Record<string, string | undefined>,
 *   run?: (exe: string, args: string[], opts: { env: Record<string, string | undefined>, stdio: any }) => import('node:events').EventEmitter & { kill: (signal: string) => void },
 *   exists?: (file: string) => boolean, read?: (file: string) => string, tmp?: () => string, rm?: (dir: string) => void }} LaunchDeps
 */

/**
 * Starts the app and waits for it to exit (or kills it after `timeoutMs`). Resolves with the result it wrote; throws
 * with the reason when it did not start.
 * @param {string} appPath
 * @param {LaunchDeps} [deps]
 */
export async function smokeLaunch(
  appPath,
  {
    productName = PKG.productName,
    platform = process.platform,
    timeoutMs = TIMEOUT_MS,
    env = process.env,
    version = env.RELEASE_VERSION || PKG.version,
    run = /** @type {NonNullable<LaunchDeps['run']>} */ (/** @type {unknown} */ (spawn)),
    exists = existsSync,
    read = (/** @type {string} */ f) => readFileSync(f, 'utf8'),
    tmp = () => mkdtempSync(path.join(os.tmpdir(), 'mopilot-smoke-')),
    rm = (/** @type {string} */ dir) => rmSync(dir, { recursive: true, force: true }),
  } = {},
) {
  const exe = executableOf(appPath, productName, platform);
  if (!exists(exe)) throw new Error(`No app at ${exe}`);
  const dir = tmp();
  const resultFile = path.join(dir, 'result.json');
  try {
    const child = run(exe, [], {
      env: { ...env, MOPILOT_USER_DATA: path.join(dir, 'user-data'), MOPILOT_SMOKE_RESULT: resultFile, SAGE_E2E_BACKGROUND: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    /** @type {{ code: number | null, timedOut: boolean, error?: Error }} */
    const ended = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, timedOut: true });
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, timedOut: false, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
    });
    if (ended.error) throw new Error(`The app did not start: ${ended.error.message}`);
    /** @type {{ ok: boolean, error?: string, version?: string } | null} */
    let result = null;
    // no result (the app quit, hung or crashed before reporting): why it can't be read goes in the error below
    let unread = '';
    try {
      result = JSON.parse(read(resultFile));
    } catch (error) {
      unread = /** @type {Error} */ (error).message;
    }
    if (result && !result.ok) throw new Error(`The packaged app failed to start: ${result.error}`);
    if (ended.timedOut) throw new Error(`The packaged app did not finish starting within ${timeoutMs / 1000} s`);
    if (!result) throw new Error(`The packaged app exited (code ${ended.code}) without reporting how its startup ended (${unread})`);
    if (ended.code !== 0) throw new Error(`The packaged app reported a start but exited with code ${ended.code}`);
    if (result.version !== version) throw new Error(`The packaged app reports version ${result.version}, not the release's ${version}`);
    return result;
  } finally {
    rm(dir);
  }
}

/**
 * smokeLaunch() for the command line. Returns the exit code.
 * @param {string[]} argv
 * @param {LaunchDeps & { log?: (...a: any[]) => void, error?: (...a: any[]) => void, gate?: typeof requireRelease }} [o]
 */
export async function main(argv, { log = console.log, error = console.error, gate = requireRelease, ...deps } = {}) {
  const [appPath] = argv;
  if (!appPath) {
    error('usage: node scripts/smoke-launch.mjs <path to the packaged .app or Windows/Linux app folder>');
    return 2;
  }
  try {
    gate('The smoke launch', 'starts the packaged MoPilot on this computer', deps.env ?? process.env);
    await smokeLaunch(appPath, deps);
    log(`Smoke launch passed: ${appPath}`);
    return 0;
  } catch (e) {
    error(/** @type {Error} */ (e).message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));

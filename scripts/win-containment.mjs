// The Windows containment check (docs/architecture/rust-core.md §6 step 1, #2784): the installed MoPilot holds each
// harness in a Job Object, so a command the harness started ends with it even once that command's own parent has
// exited, where no process-tree walk reaches it. With the fake harness tests/e2e/fixtures/fake-codex-orphan.mjs:
// - the harness exits on its own: MoPilot ends what its job still holds (winbin.cjs endGroup, the core's proc.endContained);
// - MoPilot quits: it ends the harness and what its job holds (killTree, the core's proc.kill).
// A control first shows such a command outliving its parent with no MoPilot around, so a pass means MoPilot ended it.
//   node scripts/win-containment.mjs "<installed app folder>"    (the win-containment workflow on a Windows runner)
// Release-only, like the smoke launch: it starts the installed app.
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { firstPublishedLine } from './fixture-json-log.mjs';

const { requireRelease } = createRequire(import.meta.url)('./release-suites.cjs');

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const FAKE_HARNESS = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'fake-codex-orphan.mjs');
export const PRODUCT = 'MoPilot';
/** How long the harness gets to start and leave its command; how long that command may take to end once it should. */
export const START_MS = 90_000;
export const END_MS = 30_000;
/** How long the control waits to see the orphan outlive its launcher. */
export const CONTROL_MS = 3000;

/**
 * Start a command through a launcher that exits at once, as a harness's tool call or a shell's `start` does, and return
 * the command's pid: its parent is gone, so only a Job Object (or nothing) still reaches it.
 * @param {(file: string, args: string[], o: object) => string | Buffer} [run]
 */
export function startOrphan(run = execFileSync) {
  const launcher = [
    "const { spawn } = require('node:child_process');",
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore', windowsHide: true });",
    'process.stdout.write(String(c.pid));',
    'c.unref();',
  ].join(' ');
  return Number(String(run(process.execPath, ['-e', launcher], { encoding: 'utf8', windowsHide: true })).trim());
}

/** Whether a process runs at `pid` (EPERM: one runs that this user may not signal). @param {number} pid */
export function alive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** @param {number} ms */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `ok()` holds, checking every `everyMs`; false once `timeoutMs` passed without it.
 * @param {() => boolean} ok @param {number} timeoutMs
 * @param {{ everyMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} [o]
 */
export async function until(ok, timeoutMs, { everyMs = 250, sleep = pause, now = Date.now } = {}) {
  const end = now() + timeoutMs;
  for (;;) {
    if (ok()) return true;
    if (now() >= end) return false;
    await sleep(everyMs);
  }
}

/** @param {string} f */
const readFile = (f) => fs.readFileSync(f, 'utf8');

/** A file's text, or null when it is not there (or `file` names none). @param {string | undefined} file */
const textOf = (file, read = readFile) => {
  try {
    return file ? read(file) : null;
  } catch {
    return null;
  }
};

/** The pid the fake harness wrote, or null while it hasn't. @param {string} file */
export function orphanPid(file, read = readFile) {
  const pid = Number(firstPublishedLine(textOf(file, read)));
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/**
 * A scratch profile for one launch: user data that names the fake harness as Codex (so no installed one is found), and
 * the environment that points the app at it. The runner's own home stays: a USERPROFILE without an AppData folder leaves
 * Electron no 'appData' path, and the app stops at startup behind an error dialog.
 * @param {string} dir @param {{ exitHarness: boolean, env?: Record<string, string | undefined> }} o
 * @returns {Profile}
 */
export function profile(dir, { exitHarness, env = process.env }) {
  const userData = path.join(dir, 'user-data');
  const codexHome = path.join(dir, 'codex-home');
  for (const d of [userData, codexHome]) fs.mkdirSync(d, { recursive: true });
  const prefs = { confirmClose: 'never', shareUsageData: false, autoUpdate: false, importSync: false };
  fs.writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify({ codexBin: FAKE_HARNESS, prefs }));
  const pidFile = path.join(dir, 'orphan.pid');
  const logFile = path.join(dir, 'electron.log');
  return {
    pidFile,
    logFile,
    env: {
      ...env,
      MOPILOT_USER_DATA: userData,
      CODEX_HOME: codexHome,
      CODEX_BIN: FAKE_HARNESS,
      FAKE_CODEX_LOG: path.join(dir, 'fake-codex.jsonl'),
      FAKE_CODEX_PROJECTS: '[]',
      FAKE_CODEX_ORPHAN_PID: pidFile,
      FAKE_CODEX_ORPHAN_EXIT: exitHarness ? '1' : '0',
      // opens behind other windows, sends nothing anywhere (electron/app/backgroundMode.cjs)
      SAGE_E2E_BACKGROUND: '1',
      SAGE_NO_RELAY: '1',
      MOPILOT_API: 'http://127.0.0.1:9',
      // a packaged Windows app writes nothing to its stdout: Electron's own log (the windows' console among it) goes here
      ELECTRON_ENABLE_LOGGING: 'file',
      ELECTRON_LOG_FILE: logFile,
    },
  };
}

/**
 * @typedef {{ pidFile: string, logFile: string, env: Record<string, string | undefined> }} Profile
 * @typedef {{ on: (e: 'data', f: (chunk: Buffer | string) => void) => unknown }} Stream
 * @typedef {{ pid?: number, exitCode: number | null, once: (e: 'exit' | 'error', f: (arg?: Error | number | null) => void) => unknown,
 *   stdout?: Stream | null, stderr?: Stream | null }} AppProcess
 * @typedef {{
 *   spawn?: (exe: string, args: string[], o: object) => AppProcess,
 *   taskkill?: (args: string[]) => Promise<unknown>,
 *   mkdtemp?: () => string,
 *   rm?: (dir: string) => void,
 *   profile?: typeof profile,
 *   orphanPid?: typeof orphanPid,
 *   alive?: (pid: number) => boolean,
 *   until?: typeof until,
 *   log?: (m: string) => void,
 * }} Deps
 */

/** How many of the app's last output and log lines a failed case shows. */
export const OUTPUT_LINES = 40;

/**
 * What a failed case saw, for the log: whether the fake harness ever ran (it creates its pid file as it starts), what
 * the app asked it (the fake Codex logs each request), and the app's last output and Electron log lines (its windows'
 * console among them).
 * @param {Profile} p @param {string[]} output
 */
export function explain(p, output, read = readFile) {
  /** @param {string | undefined} f */
  const text = (f) => textOf(f, read);
  const pid = text(p.pidFile);
  const requests = (text(p.env.FAKE_CODEX_LOG) ?? '').split('\n').filter(Boolean);
  const methods = requests.map((line) => /"method":"([^"]+)"/.exec(line)?.[1] ?? '?').slice(0, 12);
  const logged = (text(p.logFile) ?? '').split(/\r?\n/).filter(Boolean).slice(-OUTPUT_LINES);
  /** @param {string} title @param {string[]} lines */
  const block = (title, lines) => `  ${title}:${lines.length ? `\n${lines.map((l) => `    ${l}`).join('\n')}` : ' none'}`;
  return [
    `  the fake harness: ${pid === null ? 'never started' : pid.trim() ? `started command ${pid.trim()}` : 'started, no command yet'}`,
    `  the app's requests to it: ${requests.length ? `${requests.length} (${methods.join(', ')})` : 'none'}`,
    block("the app's last output", output),
    block("the app's log", logged),
  ].join('\n');
}

/** Run taskkill with `args`; resolves its error (a process already gone among them), never rejects. @param {string[]} args */
export const taskkill = (args) => new Promise((resolve) => execFile('taskkill', args, { windowsHide: true }, (error) => resolve(error)));

/**
 * One launch of the installed app with the fake harness: wait for the orphaned command, then either let the harness
 * exit (exitHarness) or quit the app, and say whether the command ended. The app and any leftover are always stopped.
 * @param {string} exe @param {{ exitHarness: boolean }} c @param {Deps} [d]
 * @returns {Promise<string | null>} why the case failed, or null when it passed
 */
export async function runCase(exe, { exitHarness }, d = {}) {
  const {
    spawn: start = spawn,
    taskkill: kill = taskkill,
    mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-containment-')),
    rm = (/** @type {string} */ dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    profile: makeProfile = profile,
    orphanPid: readPid = orphanPid,
    alive: running = alive,
    until: wait = until,
    log = console.log,
  } = d;
  const dir = mkdtemp();
  const p = makeProfile(dir, { exitHarness });
  const app = start(exe, [], { env: p.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  /** @type {string[]} the app's last output lines, shown when the case fails */
  const output = [];
  const keep = (/** @type {Buffer | string} */ chunk) => {
    output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    output.splice(0, Math.max(0, output.length - OUTPUT_LINES));
  };
  app.stdout?.on('data', keep);
  app.stderr?.on('data', keep);
  let exited = false;
  /** @type {number | null | undefined} the app's exit code, once it exited */
  let code;
  /** @type {Error | undefined} */
  let failed;
  app.once('exit', (c) => {
    exited = true;
    code = /** @type {number | null} */ (c);
  });
  // an exe that can't start (a missing install) is reported as an error, not an exit
  app.once('error', (error) => {
    exited = true;
    failed = /** @type {Error} */ (error);
  });
  /** @type {number | null} */
  let pid = null;
  const attempt = async () => {
    const started = await wait(() => (pid = readPid(p.pidFile)) !== null || exited, START_MS);
    if (failed) return `the app did not start: ${failed.message}`;
    if (pid === null && exited) return `the app exited (code ${code}) before its harness started a command`;
    if (!started) return 'the harness never started its command';
    const orphan = Number(pid);
    log(`  the harness started command ${orphan}, whose parent has exited`);
    if (!running(orphan)) return `command ${orphan} was gone before anything should have ended it`;
    if (!exitHarness) {
      // a window's close message, as clicking its close button sends: the app quits the way a user quits it
      await kill(['/PID', String(app.pid)]);
      if (!(await wait(() => exited, END_MS))) return 'the app did not quit';
      log('  the app quit');
    } else log('  the harness exits');
    if (!(await wait(() => !running(orphan), END_MS))) return `command ${orphan} outlived ${exitHarness ? 'its harness' : 'the app'}`;
    log(`  command ${orphan} ended`);
    return null;
  };
  /** @type {string | null | undefined} */
  let why;
  try {
    why = await attempt();
    if (why) log(explain(p, output));
    return why;
  } finally {
    if (pid !== null && running(pid)) await kill(['/PID', String(pid), '/T', '/F']);
    if (!exited) await kill(['/PID', String(app.pid), '/T', '/F']);
    // a passed case's scratch profile goes; a failed one's stays for whoever looks into it
    if (why === null) {
      try {
        rm(dir);
      } catch (error) {
        log(`  (left ${dir}: ${/** @type {Error} */ (error).message})`);
      }
    }
  }
}

/**
 * The control: such a command outlives its launcher when nothing holds it, so the cases measure MoPilot, not Windows.
 * @param {{ start?: () => number, alive?: (pid: number) => boolean, taskkill?: (args: string[]) => Promise<unknown>, sleep?: (ms: number) => Promise<void> }} [d]
 * @returns {Promise<string | null>}
 */
export async function control({ start = startOrphan, alive: running = alive, taskkill: kill = taskkill, sleep = pause } = {}) {
  const pid = start();
  await sleep(CONTROL_MS);
  const outlived = running(pid);
  if (outlived) await kill(['/PID', String(pid), '/T', '/F']);
  return outlived ? null : `command ${pid} ended with its launcher even with nothing holding it: the check would prove nothing`;
}

/**
 * @param {string[]} argv
 * @param {Deps & { gate?: typeof requireRelease, control?: typeof control, runCase?: typeof runCase, exists?: typeof fs.existsSync, env?: Record<string, string | undefined>, error?: (m: string) => void }} [d]
 */
export async function main(argv, d = {}) {
  const { gate = requireRelease, control: check = control, runCase: run = runCase, log = console.log, error = console.error } = d;
  const [appDir] = argv;
  if (!appDir) {
    error('usage: node scripts/win-containment.mjs <installed MoPilot folder>');
    return 2;
  }
  gate('The Windows containment check', 'starts the installed MoPilot on this computer', d.env ?? process.env);
  const renamed = path.join(appDir, `${PRODUCT}.exe`);
  const legacy = path.join(appDir, 'MoPilot Code.exe');
  const exists = d.exists ?? fs.existsSync;
  const exe = !exists(renamed) && exists(legacy) ? legacy : renamed;
  const failures = [];
  const steps = /** @type {[string, () => Promise<string | null>][]} */ ([
    ['control: a command whose parent exited outlives it with nothing holding it', () => check()],
    ['a harness that exits leaves none of its commands running', () => run(exe, { exitHarness: true }, d)],
    ['quitting MoPilot ends the commands its harness started', () => run(exe, { exitHarness: false }, d)],
  ]);
  for (const [name, step] of steps) {
    log(name);
    const why = await step();
    log(why ? `  FAIL: ${why}` : '  ok');
    if (why) failures.push(`${name}: ${why}`);
  }
  if (failures.length) {
    error(`The Windows containment check failed:\n${failures.join('\n')}`);
    return 1;
  }
  log('The Windows containment check passed.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));

// The Host's headless Chromium: finds a system Chrome or Chromium and starts it with --remote-debugging-pipe, so the browser is reachable only through the pipe this process holds (never a TCP debugging port).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCdpPipe } from './cdpPipe.mjs';

export class ChromiumError extends Error {
  /** @param {'no_chromium' | 'downloading' | 'download_failed' | 'spawn_failed' | 'exited'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ChromiumError';
    this.code = code;
  }
}

/** The names a Linux distribution gives Chrome, in the order they are tried. */
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome-headless-shell'];
const MAC_APPS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];

/** How much of Chromium's stderr is kept to say why it exited. */
const STDERR_TAIL = 2000;
/** How long Chromium has to exit after SIGTERM before it is killed. */
const KILL_MS = 2000;

/** Whether `file` is an executable file. @param {string} file */
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The Chrome or Chromium to start: MOPILOT_HOST_CHROME when set (it must exist), else the platform's usual places.
 * Null when none is installed (the caller reports it; a downloaded chrome-headless-shell is a later fallback).
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (file: string) => boolean }} [o]
 * @returns {string | null}
 */
export function findChromium({ env = process.env, platform = process.platform, isFile = isExecutable } = {}) {
  if (env.MOPILOT_HOST_CHROME) return isFile(env.MOPILOT_HOST_CHROME) ? env.MOPILOT_HOST_CHROME : null;
  if (platform === 'darwin') return MAC_APPS.find(isFile) ?? null;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const name of LINUX_NAMES) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/**
 * Starts the browser on its own profile dir and resolves once the process runs.
 * `exited` settles when it ends, whoever ended it; `stop` ends it (SIGTERM, then SIGKILL after a short wait).
 * It also exits when the pipe closes, so a Host that dies takes no browser with it.
 * @param {{ executable: string, userDataDir: string, spawn?: typeof nodeSpawn, root?: boolean,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, killMs?: number }} o
 *   root: whether this process is root, where Chromium refuses to run its sandbox
 * @returns {Promise<{ pipe: ReturnType<typeof createCdpPipe>, pid: number | undefined,
 *                     exited: Promise<{ code: number | null, signal: string | null, stderr: string }>, stop: () => void }>}
 */
/** The environment names a headless browser needs; the rest of the Host's (harness API keys, tokens, `GIT_*`) never reaches a process that runs a page's code. */
const BROWSER_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|DISPLAY|XDG_[A-Z_]+|FONTCONFIG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS)$/;

/** The environment the browser runs in: only the names it needs. @param {NodeJS.ProcessEnv} env */
export const browserEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => BROWSER_ENV.test(k)));

export function launchChromium({
  executable,
  userDataDir,
  spawn = nodeSpawn,
  root = process.getuid?.() === 0,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  killMs = KILL_MS,
  env = process.env,
}) {
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    ...(root ? ['--no-sandbox'] : []),
  ];
  return new Promise((resolve, reject) => {
    // fd 3 is what Chromium reads and fd 4 what it writes: the pipe's write and read ends here
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: browserEnv(env) });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    /** @type {any} */
    let killTimer = null;
    const exited = new Promise((done) =>
      child.once('exit', (code, signal) => {
        clearTimer(killTimer);
        done({ code, signal, stderr });
      }),
    );
    child.once('error', (e) => reject(new ChromiumError('spawn_failed', `Could not start ${executable}: ${e.message}`)));
    child.once('spawn', () => {
      const pipe = createCdpPipe({ read: /** @type {any} */ (child.stdio[4]), write: /** @type {any} */ (child.stdio[3]) });
      resolve({
        pipe,
        pid: child.pid,
        exited: /** @type {any} */ (exited),
        stop() {
          pipe.close();
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGTERM');
          killTimer = setTimer(() => child.kill('SIGKILL'), killMs);
          killTimer.unref?.();
        },
      });
    });
  });
}

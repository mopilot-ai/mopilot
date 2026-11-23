// VM-only glue for the harness version contract (bench/contract-run.mjs): real child processes with a timeout, the
// files, the run's own fixture server and MoPilot instances, the process watch that proves the pinned CLI ran, and
// what the result records about the machine. Everything it starts it stops by its own pids.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { benchFlags } from '../lib/claudeChrome.mjs';
import { servingProcess } from '../lib/contract.mjs';

const { chromeExecutable } = createRequire(import.meta.url)('../../electron/capabilities/browser/userChrome.cjs');

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a command to its end and resolves its exit code and output; past `timeoutMs` its whole process group is killed.
 * @param {string} cmd @param {string[]} args @param {{ cwd?: string, env?: Record<string, string>, timeoutMs: number }} o
 */
export function exec(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (b) => {
      stdout += b;
      process.stdout.write(b);
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      process.stderr.write(b);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** SIGTERM to a process group the run started, then SIGKILL; a group that is gone already is fine. @param {number | undefined} pid */
function killGroup(pid) {
  if (!pid) return;
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
    try {
      process.kill(-pid, sig);
    } catch {
      // already exited
      return;
    }
    if (sig === 'SIGTERM') execFileSync('sleep', ['2']);
  }
}

export const files = {
  readFile: (/** @type {string} */ f) => fs.readFileSync(f, 'utf8'),
  writeFile: (/** @type {string} */ f, /** @type {string} */ s) => fs.writeFileSync(f, s),
  rename: (/** @type {string} */ a, /** @type {string} */ b) => fs.renameSync(a, b),
  mkdir: (/** @type {string} */ d) => fs.mkdirSync(d, { recursive: true }),
  /** mkdir without -p: throws EEXIST when it is there (the run lock) */
  mkdirExclusive: (/** @type {string} */ d) => fs.mkdirSync(d),
  rm: (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true }),
  readdir: (/** @type {string} */ d) => fs.readdirSync(d),
};

/**
 * Starts a detached process with its output in `log`, and a handle that stops its group.
 * @param {string} cmd @param {string[]} args @param {{ cwd: string, env?: Record<string, string>, log: string }} o
 */
function background(cmd, args, { cwd, env, log }) {
  const out = fs.openSync(log, 'a');
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return { pid: child.pid, stop: async () => killGroup(child.pid) };
}

/** Whether something answers at `url` now. @param {string} url */
async function answers(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    // nothing listening
    return false;
  }
}

/** Waits until `url` answers, or throws after `ms`. @param {string} url @param {number} ms */
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`${url} did not answer within ${ms / 1000} s`);
    await sleep(1000);
  }
}

/**
 * The glue for one checkout.
 * @param {{ root: string, dir: string }} o root: the MoPilot checkout (built); dir: where logs go
 */
export function contractDeps({ root, dir }) {
  const tls = path.join(os.homedir(), 'edge-tls');
  return {
    exec,
    fs: files,
    pid: process.pid,
    alive: (/** @type {number} */ pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM: alive, someone else's
        return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
      }
    },
    node: process.execPath,
    now: Date.now,
    log: (/** @type {string} */ s) => console.log(s),
    async startFixtures({ port, events }) {
      // never grade against another run's fixtures
      if (await answers(`http://localhost:${port}/`)) throw new Error(`port ${port} is in use: another fixture server runs there`);
      fs.mkdirSync(tls, { recursive: true });
      if (!fs.existsSync(path.join(tls, 'cert.pem')))
        execFileSync('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          path.join(tls, 'key.pem'),
          '-out',
          path.join(tls, 'cert.pem'),
          '-subj',
          '/CN=localhost',
          '-days',
          '3',
        ]);
      const h = background(
        process.execPath,
        ['bench/edge-serve.mjs', String(port), events, path.join(tls, 'key.pem'), path.join(tls, 'cert.pem')],
        {
          cwd: root,
          log: path.join(dir, 'fixtures.log'),
        },
      );
      await waitFor(`http://localhost:${port}/`, 30_000);
      return h;
    },
    async startMgbFixtures({ port, token }) {
      // the 12-Grid Bench's fixture apps, with this run's grader token
      if (await answers(`http://127.0.0.1:${port}/`)) throw new Error(`port ${port} is in use: another MGB fixture server runs there`);
      const h = background(process.execPath, ['bench/mgb-serve.mjs', String(port)], {
        cwd: root,
        env: { MGB_TOKEN: token },
        log: path.join(dir, 'mgb-fixtures.log'),
      });
      await waitFor(`http://127.0.0.1:${port}/`, 30_000);
      return h;
    },
    async startInstance({ port, userData, chromeProfile }) {
      // never drive another run's instance
      if (await answers(`http://127.0.0.1:${port}/json/version`)) throw new Error(`port ${port} is in use: another instance runs there`);
      const h = background(path.join(root, 'node_modules/.bin/electron'), ['.', `--remote-debugging-port=${port}`], {
        cwd: root,
        env: {
          SAGE_E2E_BACKGROUND: '1',
          // computer-use tasks: the VM's driver counts as present (honored only inside a VM, #1600)
          MOPILOT_BENCH_ATTENDED: '1',
          // Claude in Chrome off: its pairing is account-wide and can reach a Chrome on another device (#1561)
          MOPILOT_FLAGS: benchFlags(process.env.MOPILOT_FLAGS),
          MOPILOT_USER_DATA: userData,
          // a Chrome the instance starts (its Chrome relay) gets the run's own profile, through a wrapper that refuses
          // any start without one: the VM's default profile is a real, signed-in one
          MOPILOT_CHROME_RELAY_USER_DATA_DIR: chromeProfile,
          MOPILOT_CHROME_RELAY_EXECUTABLE: path.join(root, 'bench/scratch-chrome.mjs'),
          MOPILOT_SCRATCH_CHROME_REAL: chromeExecutable({ env: {} }),
          // MoPilot's extension, loaded into that Chrome on every start (Chrome 155 keeps no unpacked one, #1561)
          MOPILOT_SCRATCH_CHROME_EXTENSION: path.join(root, 'electron/chrome-extension'),
          // and paired with the instance as its operator would (the pairing page waits for a person's Pair)
          MOPILOT_SCRATCH_CHROME_PAIR: '1',
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        },
        log: `${userData}.log`,
      });
      await waitFor(`http://127.0.0.1:${port}/json/version`, 60_000);
      // the window loads its state and finds the harnesses
      await sleep(8000);
      return h;
    },
    /** The pids of the Chrome browser processes running now. */
    chromePids() {
      try {
        return execFileSync('pgrep', ['-x', 'Google Chrome'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
      } catch {
        // none running
        return [];
      }
    },
    /** Quits the Chrome processes a run started (SIGTERM: Chrome closes its windows and helpers). @param {number[]} pids */
    quitPids(pids) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    },
    /** Polls the process list for a CLI under `prefix` serving the instances while the edge suite runs. @param {string} prefix */
    watchBinary(prefix) {
      let saw = false;
      const seen = new Set();
      const look = () => {
        try {
          saw ||= servingProcess(execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }), prefix, seen);
        } catch {
          // ps failed this once; the next poll asks again
        }
      };
      const timer = setInterval(look, 2000);
      return { saw: () => (look(), saw), stop: () => clearInterval(timer) };
    },
    async info() {
      const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
        try {
          return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          // recorded as unknown
          return null;
        }
      };
      return {
        commit: run('git', ['rev-parse', 'HEAD']),
        app: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null,
        macos: run('sw_vers', ['-productVersion']),
        node: process.version,
        vm: os.hostname(),
        // the switch cell runs the other first-class harness as installed on the VM
        claude: run('claude', ['--version']),
        codex: run('codex', ['--version']),
      };
    },
  };
}

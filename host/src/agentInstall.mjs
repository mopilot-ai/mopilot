// Installing a missing agent CLI on this Host: only the vendor's npm package from the app's own install table (shared/harnessInstall.mjs), into a prefix of this Host's own (`<data dir>/tools`, no root), one install at a time, its output reduced to one calm line and an exact error.
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ACP_CATALOG } from '../../shared/harnessCatalog.mjs';
import { HARNESS_INSTALL, installOs } from '../../shared/harnessInstall.mjs';
import { which as whichOnPath } from './acp.mjs';
import { isAlive, startedAfterWriting } from './children.mjs';

/** How long one install may run before it is stopped. */
export const INSTALL_MS = 10 * 60_000;
/** How long the installed CLI may take to print its version. */
const VERSION_MS = 15_000;
/** How long a stopped install may take to exit before it is killed. */
const KILL_MS = 5000;
/** The output kept for the error of a failed install. */
const TAIL_LINES = 40;
/** What follows `npm install -g ` in the table: a package name, maybe scoped, maybe with a dist-tag or version. Anything else is not run. */
const SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.-]+)?$/;
const NPM_PREFIX = 'npm install -g ';

/** Where this Host's installs go: a prefix of its own, so no root is needed and removing the folder removes them. @param {string} dataDir */
export const toolsDir = (dataDir) => path.join(dataDir, 'tools');

/**
 * The PATH this Host runs with: its own, then the folder its installs put binaries in, then the folder of the Node it runs on (an npm-installed CLI starts with `env node`). An agent the person installed themselves comes first.
 * @param {string | undefined} pathEnv @param {string} dataDir @param {string} [execPath]
 */
export function hostPath(pathEnv, dataDir, execPath = process.execPath) {
  const dirs = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [path.join(toolsDir(dataDir), 'bin'), path.dirname(execPath)]) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs.join(path.delimiter);
}

/** The id the install table keys a harness the Host lists under: Claude Code and Codex by name, an ACP agent as `acp:<id>`. @param {string} harness */
const kindOf = (harness) => (harness === 'claude' || harness === 'codex' ? harness : `acp:${harness}`);

/** The name the person knows an agent by; only asked of a harness the install table names, so an ACP one is in the catalog. @param {string} harness */
const nameOf = (harness) => (harness === 'claude' ? 'Claude Code' : harness === 'codex' ? 'Codex' : ACP_CATALOG[harness].label);

/** The binaries an install of the harness provides. @param {string} harness @returns {string[]} */
const binsOf = (harness) => (harness === 'claude' || harness === 'codex' ? [harness] : ACP_CATALOG[harness].bins);

/**
 * What this Host may install for a harness: the vendor's npm package from the install table, for this OS. Null for a harness with no npm line (a vendor that ships only a script or an app), on Windows, or for an id the table does not know.
 * @param {string} harness @param {NodeJS.Platform} [platform]
 * @returns {{ harness: string, name: string, spec: string, bins: string[] } | null}
 */
export function installRecipe(harness, platform = process.platform) {
  if (typeof harness !== 'string' || installOs(platform) === 'win32') return null;
  const kind = kindOf(harness);
  if (!Object.hasOwn(HARNESS_INSTALL, kind)) return null;
  const line = HARNESS_INSTALL[kind].methods.find(
    (/** @type {any} */ m) => m.via === 'npm' && m.os.includes(installOs(platform)) && m.command.startsWith(NPM_PREFIX),
  );
  const spec = line?.command.slice(NPM_PREFIX.length);
  const bins = binsOf(harness);
  if (!spec || !SPEC.test(spec) || bins.length === 0) return null;
  return { harness, name: nameOf(harness), spec, bins };
}

/** Output of another machine's tools is shown to the person: tokens, passwords in addresses and auth headers are cut out first. @param {string} line */
export function scrub(line) {
  return line
    .replace(/(_authToken|_auth|_password|token|password)(\s*[=:]\s*)\S+/gi, '$1$2***')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***')
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@');
}

/** The reason a failed npm run gives, as one line in words: what its error code means, else its own error lines. The code itself is left out: the app reads a system code in a message as its own generic sentence. @param {string[]} tail @param {number | null} code */
export function npmReason(tail, code) {
  const text = tail.join('\n');
  const npmCode = /npm (?:error|ERR!) code (\w+)/.exec(text)?.[1] ?? '';
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT)$/.test(npmCode))
    return "Couldn't reach the npm registry. Check this machine's network or proxy.";
  if (npmCode === 'E404') return 'npm could not find the package.';
  if (npmCode === 'EACCES' || npmCode === 'EPERM') return 'npm was not allowed to write its files.';
  if (/^(SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED)$/.test(npmCode))
    return "npm did not trust the registry's certificate. Check this machine's proxy settings.";
  const said = tail
    .filter((l) => /npm (error|ERR!)/.test(l) && !/A complete log of this run|npm (error|ERR!) code |npm (error|ERR!)\s*$/.test(l))
    .map((l) => l.replace(/^npm (error|ERR!)\s*/, ''))
    .slice(-3)
    .join(' ');
  return said || (code === null ? 'npm was stopped before it finished.' : `npm ended with code ${code}.`);
}

/** @typedef {{ harness: string, state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled', line: string, error: string | null, version: string | null }} Install */

/**
 * @param {{
 *   dataDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   execPath?: string,
 *   which?: typeof whichOnPath,
 *   spawnFn?: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess,
 *   installMs?: number,
 *   versionMs?: number,
 *   killMs?: number,
 * }} o env: the Host's own (its PATH already carries the tools folder, ./agentInstall.mjs hostPath); which/spawnFn/execPath/platform: replaced by tests
 */
export function createInstaller({
  dataDir,
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  which = whichOnPath,
  spawnFn = spawnChild,
  installMs = INSTALL_MS,
  versionMs = VERSION_MS,
  killMs = KILL_MS,
}) {
  const prefix = toolsDir(dataDir);
  /** The install under way or waiting for each harness. @type {Map<string, { install: Install, abort: AbortController }>} */
  const running = new Map();
  /** Every install not yet ended, cancelled ones whose npm is still exiting included. @type {Set<{ install: Install, abort: AbortController }>} */
  const pending = new Set();
  /** The last install of each harness, so a caller that reconnects reads how it ended. @type {Map<string, Install>} */
  const last = new Map();
  /** npm runs one at a time: two installs into one prefix at once corrupt each other's folders. */
  let queue = Promise.resolve();
  let closed = false;

  /** The environment npm and the new CLI run with: the Host's, with the Node it runs on first, so npm and its scripts use a Node this Host knows works. */
  const runEnv = () => ({ ...env, PATH: [path.dirname(execPath), env.PATH ?? ''].filter(Boolean).join(path.delimiter) });

  /** One process to its end: its exit code and the output it printed, cut short by the timeout or the abort. @param {string} bin @param {string[]} args @param {{ signal: AbortSignal, ms: number, onLine?: (line: string) => void, onStart?: (child: import('node:child_process').ChildProcess) => void }} o */
  function runProcess(bin, args, { signal, ms, onLine = () => undefined, onStart = () => undefined }) {
    return new Promise((resolve, reject) => {
      // its own process group (installs run on macOS and Linux only, installRecipe): npm starts scripts of its own, and the whole group goes when it is stopped
      const child = spawnFn(bin, args, { env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      onStart(child);
      /** @type {string[]} */
      const tail = [];
      const read = (/** @type {string} */ raw) => {
        const line = scrub(raw.trim());
        if (!line) return;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        onLine(line);
      };
      const kill = (/** @type {NodeJS.Signals} */ sig) => {
        try {
          process.kill(-(/** @type {number} */ (child.pid)), sig);
        } catch {
          // no group to signal (it never started, or is not a group of its own): the process itself
          child.kill(sig);
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        let partial = '';
        stream?.setEncoding('utf8');
        stream?.on('data', (/** @type {string} */ text) => {
          const lines = (partial + text).split(/\r?\n|\r/);
          partial = /** @type {string} */ (lines.pop());
          lines.forEach(read);
        });
        stream?.on('end', () => read(partial));
      }
      /** Why it is being stopped; the run settles only once the process is gone, so the next install never shares the prefix with it. @type {Error | null} */
      let stopping = null;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let hard;
      const stop = (/** @type {Error} */ why) => {
        if (stopping) return;
        stopping = why;
        kill('SIGTERM');
        // npm finishes what it is writing on SIGTERM; one that keeps going is killed
        hard = setTimeout(() => kill('SIGKILL'), killMs);
        hard.unref?.();
      };
      const timer = setTimeout(() => stop(Object.assign(new Error('timeout'), { timedOut: true })), ms);
      timer.unref?.();
      const onAbort = () => stop(Object.assign(new Error('Install was cancelled.'), { cancelled: true }));
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = () => (clearTimeout(timer), clearTimeout(hard), signal.removeEventListener('abort', onAbort));
      child.once('error', (e) => (settle(), reject(stopping ?? e)));
      child.once('close', (code) => (settle(), stopping ? reject(stopping) : resolve({ code, tail })));
    });
  }

  /** The npm this Host runs: the one beside the Node it runs on, else the first on its PATH (the PATH the Host was installed with). */
  const npmBin = () => which('npm', runEnv());

  /** Where the npm run under way writes its pid: an npm a Host killed hard left running is found by the next Host before it starts one of its own. */
  const pidFile = path.join(prefix, '.npm.pid');
  /** An npm an earlier Host left running in the prefix is stopped and waited for (killed after killMs), so two never write it at once. */
  async function reapOrphan() {
    let pid = Number.NaN;
    let writtenAt = 0;
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      writtenAt = fs.statSync(pidFile).mtimeMs;
    } catch {
      return;
    }
    // after a reboot the same number can be any process: one that started after the file was written is not that npm, so it gets no signal
    if (Number.isSafeInteger(pid) && pid > 1 && isAlive(pid) && !(await startedAfterWriting(pid, writtenAt))) {
      const signal = (/** @type {NodeJS.Signals} */ sig) => {
        try {
          process.kill(-pid, sig);
        } catch {
          // gone already, or not a group of its own
        }
      };
      signal('SIGTERM');
      const end = Date.now() + killMs;
      while (isAlive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      if (isAlive(pid)) signal('SIGKILL');
      while (isAlive(pid) && Date.now() < end + killMs) await new Promise((r) => setTimeout(r, 50));
    }
    fs.rmSync(pidFile, { force: true });
  }
  /** What a run that did not finish put on the PATH goes again: a binary that does not start must not read as installed. @param {NonNullable<ReturnType<typeof installRecipe>>} recipe */
  const dropBins = (recipe) => {
    for (const b of recipe.bins) fs.rmSync(path.join(prefix, 'bin', b), { force: true });
  };

  /** @param {Install} install @param {NonNullable<ReturnType<typeof installRecipe>>} recipe @param {AbortSignal} signal */
  async function run(install, recipe, signal) {
    if (signal.aborted) throw Object.assign(new Error('Install was cancelled.'), { cancelled: true });
    const npm = npmBin();
    if (!npm) throw new Error("npm isn't on this machine's PATH. Install Node.js 22 or later with npm, then try again.");
    install.state = 'running';
    install.line = `Installing ${recipe.name}…`;
    fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
    await reapOrphan();
    try {
      await runNpm(install, recipe, signal, npm);
    } catch (e) {
      dropBins(recipe);
      throw e;
    }
  }

  /** @param {Install} install @param {NonNullable<ReturnType<typeof installRecipe>>} recipe @param {AbortSignal} signal @param {string} npm */
  async function runNpm(install, recipe, signal, npm) {
    if (signal.aborted) throw Object.assign(new Error('Install was cancelled.'), { cancelled: true });
    const args = ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--no-update-notifier', recipe.spec];
    /** @type {any} */
    let result;
    try {
      result = await runProcess(npm, args, {
        signal,
        ms: installMs,
        onLine: (line) => (install.line = line),
        onStart: (child) => child.pid && fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 }),
      });
    } catch (e) {
      if (/** @type {any} */ (e).timedOut) throw new Error('The install ran too long and was stopped.');
      throw e;
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
    if (result.code !== 0) throw new Error(npmReason(result.tail, result.code));
    const bin = recipe.bins.map((b) => path.join(prefix, 'bin', b)).find((b) => fs.existsSync(b));
    if (!bin) throw new Error(`npm finished, but ${recipe.name} has no ${recipe.bins[0]} command to run.`);
    // the new CLI must start here: one that cannot (a missing platform package, a Node too old for it) is not installed
    install.line = `Checking ${recipe.name}…`;
    const checked = /** @type {any} */ (
      await runProcess(bin, ['--version'], { signal, ms: versionMs }).catch((e) => {
        if (e.cancelled) throw e;
        return { code: null, tail: [e.timedOut ? 'it did not answer in time.' : String(e.message)] };
      })
    );
    if (checked.code !== 0)
      throw new Error(`${recipe.name} was installed but does not start: ${checked.tail.slice(-2).join(' ') || `code ${checked.code}`}`);
    install.version = String(checked.tail[0] ?? '').slice(0, 80) || null;
  }

  return {
    /** The harnesses this Host can install now: listed, not installed, with a line in the table. @param {{ id: string, detected: boolean }[]} harnesses */
    installable: (harnesses) => harnesses.filter((h) => !h.detected && installRecipe(h.id, platform)).map((h) => h.id),
    /**
     * Install the harness, or join the install under way or waiting for it.
     * @param {{ harness: string }} p
     * @returns {Install}
     */
    start({ harness }) {
      const now = running.get(harness);
      // a cancelled install is still ending (its npm exiting, or its turn not come): a new one waits behind it rather than joining it
      if (now && !now.abort.signal.aborted) return now.install;
      const recipe = installRecipe(harness, platform);
      if (!recipe) throw Object.assign(new Error('This Host cannot install that agent.'), { code: 'unsupported' });
      if (closed) throw new Error('The Host is stopping.');
      /** @type {Install} */
      const install = { harness, state: 'queued', line: 'Waiting for another install to finish…', error: null, version: null };
      // already on this machine (the person installed it, or an earlier install did): nothing to run
      if (recipe.bins.some((b) => which(b, env))) {
        install.state = 'done';
        install.line = '';
        last.set(harness, install);
        return install;
      }
      const abort = new AbortController();
      const entry = { install, abort };
      running.set(harness, entry);
      pending.add(entry);
      last.set(harness, install);
      const turn = queue.then(() => run(install, recipe, abort.signal));
      queue = turn.catch(() => undefined);
      turn
        .then(
          () => {
            install.state = 'done';
            install.line = '';
          },
          (/** @type {any} */ e) => {
            install.state = e.cancelled ? 'cancelled' : 'failed';
            install.error = e.cancelled ? null : scrub(String(e.message));
            install.line = '';
          },
        )
        .finally(() => {
          pending.delete(entry);
          if (running.get(harness) === entry) running.delete(harness);
        });
      return install;
    },
    /** How the harness's latest install stands; null when none was started. @param {string} harness */
    status: (harness) => last.get(harness) ?? null,
    /** Stop the install under way or waiting; false when there is none. @param {string} harness */
    cancel(harness) {
      const r = running.get(harness);
      if (!r || r.abort.signal.aborted) return false;
      r.abort.abort();
      // it reads as cancelled at once; the next install of it waits until this one's npm is gone
      r.install.state = 'cancelled';
      r.install.line = '';
      return true;
    },
    /** Whether no install runs or waits, cancelled ones still ending included (a staged update waits for that). */
    idle: () => pending.size === 0,
    /** Stop every install (the Host is closing). */
    close() {
      closed = true;
      for (const r of pending) r.abort.abort();
    },
  };
}

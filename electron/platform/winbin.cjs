// Finding and launching CLIs (codex, claude) on Windows. Pure helpers: the platform, environment
// and file checks are passed in, so they are tested on any OS (tests/winbin.test.ts).
//
// npm installs a CLI as a `.cmd` shim, which Node only runs through cmd.exe (CVE-2024-27980), and
// cmd.exe can't carry newlines or arbitrary quotes in arguments. So a shim is read and its target
// launched directly: a native .exe as is, a .js entry with node from PATH. A shim that can't be read,
// or a .js shim with no node.exe on PATH, falls back to cmd.exe, with every argument escaped. (This
// Electron can't stand in for node: the RunAsNode fuse is off, see scripts/check-fuses.mjs.)
const path = require('node:path');
const fs = require('node:fs');
const { GROUP_GRACE_MS, signalTree, watchTree } = require('./processTree.cjs');
const { core, coreCall } = require('./core.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { processCompletion } = require('./processCompletion.cjs');
const { ensureRetirementMonitor } = require('./processIdentity.cjs');
const { CoreChild } = require('./coreChild.cjs');

const win = path.win32;
/** What can be spawned on Windows (PATHEXT's .js/.vbs/.wsf belong to Windows Script Host, not node). */
const RUNNABLE = new Set(['.exe', '.com', '.cmd', '.bat']);

/** Case-insensitive lookup of a Windows environment variable (Path vs PATH). */
function getEnv(env, name) {
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
  return k ? env[k] : undefined;
}

/** Every `dir\name.ext` the PATH and PATHEXT resolve `name` to, in lookup order (not checked for existence). */
function pathLookup(name, env) {
  const exts = (getEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE.has(e));
  const own = win.extname(name).toLowerCase();
  const names = own && RUNNABLE.has(own) ? [name] : exts.map((e) => name + e);
  const out = [];
  for (const dir of (getEnv(env, 'PATH') || '').split(';')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d) for (const n of names) out.push(win.join(d, n));
  }
  return out;
}

/** Where `name` (codex, claude) is usually installed on Windows, most specific first, then PATH. */
function windowsCandidates(name, env) {
  const home = getEnv(env, 'USERPROFILE') || '';
  const appData = getEnv(env, 'APPDATA') || (home && win.join(home, 'AppData', 'Roaming'));
  const local = getEnv(env, 'LOCALAPPDATA') || (home && win.join(home, 'AppData', 'Local'));
  const scoop = getEnv(env, 'SCOOP') || (home && win.join(home, 'scoop'));
  const dirs = [
    home && win.join(home, '.local', 'bin'), // native installers (Claude Code's install.ps1)
    home && win.join(home, `.${name}`, 'bin'),
    appData && win.join(appData, 'npm'), // npm i -g
    local && win.join(local, 'Programs', name),
    local && win.join(local, 'Microsoft', 'WinGet', 'Links'),
    scoop && win.join(scoop, 'shims'),
    local && win.join(local, 'pnpm'),
    local && win.join(local, 'Volta', 'bin'),
    home && win.join(home, '.bun', 'bin'),
  ].filter(Boolean);
  const list = [];
  for (const d of dirs) list.push(win.join(d, `${name}.exe`), win.join(d, `${name}.cmd`));
  list.push(...pathLookup(name, env));
  const seen = new Set();
  return list.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The program a cmd shim (npm, pnpm, yarn) runs, resolved against the shim's folder; null when it
 * isn't a recognisable shim. npm's shim ends with `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`.
 */
function shimTarget(text, shimPath) {
  const dir = win.dirname(shimPath);
  /** @type {string | null} */
  let target = null;
  for (const m of String(text).matchAll(/"%~?dp0%?\\([^"%*]+)"/gi)) {
    if (/^node(\.exe)?$/i.test(win.basename(m[1]))) continue;
    target = m[1];
  }
  return target ? win.normalize(win.join(dir, target)) : null;
}

/* cmd.exe escaping, as cross-spawn does it: quote for the C runtime, then caret-escape cmd's metacharacters. */
const META = /([()\][%!^"`<>&|;, *?])/g;
function cmdEscapeCommand(s) {
  return String(s).replace(META, '^$1');
}
function cmdEscapeArg(s, doubleEscape) {
  let a = String(s);
  if (/[\r\n]/.test(a)) throw new Error('This argument can’t be passed through cmd.exe (it contains a line break)');
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`.replace(META, '^$1');
  // a shim passes %* on to another command line, which unescapes once more
  return doubleEscape ? a.replace(META, '^$1') : a;
}

/**
 * spawn/execFile options, plus `group`: start the program in a process group of its own (spawnGroup).
 * @typedef {(import('node:child_process').SpawnOptions | import('node:child_process').ExecFileOptions) & { group?: boolean, windowsVerbatimArguments?: boolean }} LaunchOptions
 */

/**
 * How to launch `bin args` with child_process (spawn/execFile): { command, args, options }.
 * Anywhere but Windows, and for a plain .exe, that is just the binary. `io` supplies the file reads
 * and lookups: { platform, env, execPath, readFile(p) → string|null, exists(p) → boolean }.
 * @param {string} bin @param {string[]} args @param {LaunchOptions} [options] @param {any} [io]
 * @returns {{ command: string, args: string[], options: LaunchOptions }}
 */
function launchSpec(bin, args, { group, ...rest } = {}, io) {
  let options = rest;
  // a process group of its own (POSIX): killTree and endGroup then reach everything it starts (on Windows the core's proc.kill
  // walks the tree, and detached would open a console of its own)
  if (io.platform !== 'win32') return { command: bin, args, options: group ? { ...options, detached: true } : options };
  // a console program started from a GUI app otherwise opens a console window
  options = { windowsHide: true, ...options };
  const ext = win.extname(bin).toLowerCase();
  const isJs = (p) => /\.(js|mjs|cjs)$/i.test(p);
  const node = () => pathLookup('node', io.env).find((p) => p.toLowerCase().endsWith('.exe') && io.exists(p));
  if (isJs(bin)) {
    const n = node();
    if (n) return { command: n, args: [bin, ...args], options };
    throw new Error(`Node.js is needed to run ${bin}: install it, or put node.exe on PATH`);
  }
  if (ext === '.cmd' || ext === '.bat') {
    const text = io.readFile(bin);
    const target = text && shimTarget(text, bin);
    // a script the shim runs with node needs node from PATH, whatever its name (npm's shim of cline's bin/cline, which
    // has no extension); without node the shim runs through cmd.exe (and finds its own node, or says why not)
    const script = !!target && (isJs(target) || (!RUNNABLE.has(win.extname(target).toLowerCase()) && /\bnode(\.exe)?\b/i.test(text)));
    if (target && io.exists(target) && !/\.(cmd|bat)$/i.test(target)) {
      if (!script) return launchSpec(target, args, options, io);
      const n = node();
      if (n) return { command: n, args: [target, ...args], options };
    }
    const double = !!text && text.includes('%*');
    const line = [cmdEscapeCommand(bin), ...args.map((a) => cmdEscapeArg(a, double))].join(' ');
    return {
      command: getEnv(io.env, 'ComSpec') || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { ...options, windowsVerbatimArguments: true },
    };
  }
  return { command: bin, args, options };
}

/** The real program behind a shim (for tools such as the Agent SDK that spawn a path themselves). */
function resolveShim(bin, io) {
  if (io.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return bin;
  const text = io.readFile(bin);
  const target = text && shimTarget(text, bin);
  return target && io.exists(target) ? target : bin;
}

/** The real process, environment and file system, for the main-process callers. */
const realIo = () => ({
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  readFile: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (p) => fs.existsSync(p),
});

/**
 * launchSpec against the real system, as spawn/execFile arguments: [command, args, options].
 * @template {LaunchOptions} O
 * @param {string} bin
 * @param {readonly string[]} args
 * @param {O} [options]
 * @returns {[string, string[], O]}
 */
function spawnArgs(bin, args, options) {
  const s = launchSpec(bin, [...args], options, realIo());
  // macOS: through the disclaim launcher, so the program doesn't inherit MoPilot's TCC grants
  const d = require('./disclaim.cjs').wrap(s.command, s.args);
  return [d.command, d.args, /** @type {O} */ (s.options)];
}

/**
 * Whether the child's pid now belongs to another process: the child exited, yet something answers at its pid. Its
 * group id is then someone else's (a pid is not handed out while a group with that id still has members, so a group
 * of the child's leftovers alone never makes this true).
 * @param {StoppableChild} proc
 */
function reused(proc) {
  if (proc.exitCode === null && proc.signalCode === null) return false;
  try {
    process.kill(Number(proc.pid), 0);
    return true;
  } catch (error) {
    // EPERM: another user's process has the pid; ESRCH: nothing there, so only the child's own leftovers carry its group id
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Spawn `bin args` (through spawnArgs) in a process group of its own on POSIX, and mark the child so that killTree and
 * endGroup end the whole group: the commands a harness runs, not only the harness. A harness process MoPilot stops
 * or loses must not leave its commands running (#1347).
 * @template {StoppableChild & { held?: Promise<boolean> }} C
 * @param {(command: string, args: string[], options: object) => C} spawn
 * @param {string} bin @param {string[]} args @param {{ managed?: boolean, [key: string]: any }} options
 * @param {typeof spawnArgs} [toSpawnArgs]
 * @returns {C}
 */
function spawnGroup(spawn, bin, args, { managed = false, ...options }, toSpawnArgs = spawnArgs) {
  const proc = spawn(...toSpawnArgs(bin, args, { ...options, group: true }));
  // only a real child leads a group: a stand-in a test spawned has no group, and its made-up pid is never signalled
  const { ChildProcess } = require('node:child_process');
  const real = (typeof ChildProcess === 'function' && proc instanceof ChildProcess) || proc instanceof CoreChild;
  if (real && Number(proc.pid) > 1) {
    proc.group = true;
    // Windows has no process groups: a Job Object holds what it starts instead, so endGroup still reaches it after it
    // exits. A child the core started is held already, from its spawn
    if (process.platform === 'win32') proc.job = proc.held ?? holdWindowsTree(Number(proc.pid));
    // what it starts is recorded while it runs: the commands of a harness that dies outside MoPilot is out of its tree by then (#1486)
    const watch = (proc.watch = watchTree(Number(proc.pid), managed));
    // the recording is read by the exit handlers the caller adds next; it stops being updated once the process is gone
    /** @type {import('node:events').EventEmitter} */ (/** @type {unknown} */ (proc)).once('exit', () => setImmediate(() => watch.stop()));
  }
  return proc;
}

/**
 * Signal a child's process group and every group descending from it (POSIX, electron/platform/processTree.cjs), then SIGKILL
 * what is left after GROUP_GRACE_MS. Only for a group spawnGroup made (its id is the child's pid), never pid 0 or 1,
 * and never once that pid belongs to another process. False for a child it does not apply to; otherwise the promise
 * of whether anything was there to signal (read from the process table first, without blocking main).
 * @param {StoppableChild} proc @param {NodeJS.Signals} sig
 * @returns {false | Promise<boolean>}
 */
function signalGroup(proc, sig, wait = false) {
  if (process.platform === 'win32' || !proc.group || !(Number(proc.pid) > 1)) return false;
  // a pid handed out again is no group of ours; what was recorded below the process is still ours to end
  const ownsRoot = () => {
    if (wait && proc.retiredRoot) return false;
    const same = !reused(proc);
    if (wait && !same) {
      proc.retiredRoot = true;
      proc.retiringGroups?.delete(Number(proc.pid));
    }
    return same;
  };
  const leads = ownsRoot();
  if (!leads && !proc.watch?.known.size && !proc.retiringGroups?.size) return false;
  return signalTree(leads ? Number(proc.pid) : null, sig, {
    known: proc.watch?.known,
    births: proc.watch?.births,
    ownedGroups: wait ? (proc.retiringGroups ??= new Map()) : undefined,
    valid: (group) => group !== Number(proc.pid) || ownsRoot(),
    wait,
  });
}

/** Retire a managed child before a package operation releases ownership. The caller also waits for its close event.
 * @param {StoppableChild} proc */
async function retireGroup(proc) {
  proc.watch?.stop();
  if (process.platform === 'win32')
    throw new Error('Windows package commands require manual execution; automatic retirement is unavailable.');
  const retirement = signalGroup(proc, 'SIGTERM', true);
  if (retirement === false) {
    if (proc.retiredRoot) return;
    if (Number(proc.pid) > 1 && !reused(proc)) throw new Error('The process group is not managed; retirement is unverified.');
    return;
  }
  await retirement;
}

/**
 * Stop a child and everything it started. On Windows a launcher (node running codex.js, cmd.exe)
 * doesn't pass termination on, so the whole tree goes through the core; elsewhere the child's process group when
 * spawnGroup made one, else a plain SIGTERM to the child.
 * The child is marked `stopped`, so its exit handler can tell a stop from a crash.
 * @param {StoppableChild | null | undefined} proc
 */
function killTree(proc) {
  if (!proc) return;
  proc.stopped = true;
  if (process.platform !== 'win32' || !proc.pid) {
    const tree = signalGroup(proc, 'SIGTERM');
    if (!tree) return proc.kill();
    // nothing of its tree was there (a child that already exited, or a ps that failed): the child alone
    void tree.then((signalled) => signalled || proc.kill());
    return true;
  }
  endWindowsTree(proc.pid, () => proc.kill(), core(), proc.job);
}

/**
 * End a Windows process tree through the Rust core's proc.kill, with no process started. A core that did not end the
 * tree's root leaves it to `left`. A tree still being held (`held`, holdWindowsTree's promise) is ended once the hold is
 * settled, so its job ends with it.
 * @param {number} pid @param {() => unknown} left @param {ReturnType<typeof core>} [addon]
 * @param {Promise<boolean> | null} [held]
 */
function endWindowsTree(pid, left, addon = core(), held = null) {
  void Promise.resolve(held).then(async () => {
    let killed;
    try {
      killed = await coreCall('proc.kill', addon, String(pid));
    } catch (error) {
      // the tree could not be ended (its root gone, or not this user's): the child alone
      noteIgnored('end a Windows process tree', error);
    }
    if (!Array.isArray(killed) || !killed.includes(pid)) left();
  });
}

/**
 * Hold a Windows child and what it starts from now on in a Job Object (the core's proc.contain): whether it is held.
 * Called as the child is spawned: the core holds the pid only if its process had started by now,
 * so a pid handed to a later process once this one exited is never held. The core's calls run on worker threads in
 * no fixed order, so whatever ends the tree waits for this promise first.
 * @param {number} pid @param {ReturnType<typeof core>} [addon] @param {number} [now]
 * @returns {Promise<boolean>}
 */
function holdWindowsTree(pid, addon = core(), now = Date.now()) {
  return coreCall('proc.contain', addon, `${pid} ${now}`).then(
    (held) => held === true,
    (error) => {
      // not held: a stop then ends the tree by its pid, as for a child that started before the hold
      noteIgnored('hold a Windows process tree', error);
      return false;
    },
  );
}

/**
 * End what a held Windows child left running after it exited (the core's proc.endContained): only the processes its
 * job holds, never its pid, which may be another process's by now. Whether any was there.
 * @param {StoppableChild} proc @param {ReturnType<typeof core>} [addon]
 */
async function endHeld(proc, addon = core()) {
  if (!(await proc.job)) return false;
  try {
    const ended = await coreCall('proc.endContained', addon, String(proc.pid));
    return Array.isArray(ended) && ended.length > 0;
  } catch (error) {
    noteIgnored('end what a Windows process left running', error);
    return false;
  }
}

/**
 * A spawnGroup child exited on its own (a crash, or an exit after its input closed): end what it started that is
 * still running in its group, or on Windows in its job. A child killTree stopped is left alone (its group was
 * signalled already); so is one with no group of its own, and on Windows one the core did not hold.
 * @param {StoppableChild | null | undefined} proc
 * @returns {false | Promise<boolean>}
 */
function endGroup(proc) {
  if (!proc || proc.stopped) return false;
  if (process.platform === 'win32') return proc.job ? endHeld(proc) : false;
  return signalGroup(proc, 'SIGTERM');
}

/** @typedef {Pick<import('node:child_process').ChildProcess, 'pid' | 'exitCode' | 'kill'> & { signalCode: NodeJS.Signals | number | null, stopped?: boolean, group?: boolean, retiredRoot?: boolean, watch?: import('./processTree.cjs').TreeWatch, retiringGroups?: Map<number, string | null>, job?: Promise<boolean> | null }} StoppableChild */

/** PowerShell single-quoted literal. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

module.exports = {
  getEnv,
  pathLookup,
  windowsCandidates,
  shimTarget,
  cmdEscapeArg,
  cmdEscapeCommand,
  launchSpec,
  resolveShim,
  realIo,
  spawnArgs,
  spawnGroup,
  killTree,
  retireGroup,
  processCompletion,
  ensureRetirementMonitor,
  endGroup,
  GROUP_GRACE_MS,
  psQuote,
  endWindowsTree,
  holdWindowsTree,
  endHeld,
};

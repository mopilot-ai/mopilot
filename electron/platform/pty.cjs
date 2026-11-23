// Local pseudo-terminals (node-pty), keyed by id. The renderer reaches them over platform:pty:* IPC; @host-portable: loads in the Host process without Electron (host/boundary.json).
// main-process users call spawn/write/resize/kill directly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shellEnv = require('./env.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { systemBrowserEnv } = require('./browserEnv.cjs');

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Variables that belong to the folder a pty starts in (a managed worktree's name, paths and port block), set by the
 * module that knows the folders; none where nothing is set (the Host process).
 * @type {((cwd: string) => Record<string, string | null>) | null}
 */
let cwdEnv = null;
const setCwdEnv = (fn) => (cwdEnv = fn);

/** The folder's variables (null: remove an inherited one); a failure to work them out starts the pty without them rather than not at all. */
function folderEnv(cwd, lookup) {
  try {
    return lookup?.(cwd) ?? {};
  } catch (error) {
    noteIgnored("work out a terminal folder's variables", error);
    return {};
  }
}

/** The user's login shell: the passwd entry, then $SHELL, then the platform default (sh on Linux, zsh on macOS). Windows PowerShell on Windows. */
function loginShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'powershell.exe';
  /** @type {string | null} */
  let shell = null;
  try {
    shell = os.userInfo().shell;
  } catch (error) {
    // userInfo can throw for users without a passwd entry; fall back to $SHELL
    noteIgnored("read the user's login shell for a terminal", error);
  }
  return shell || env.SHELL || (platform === 'linux' ? '/bin/sh' : '/bin/zsh');
}

/**
 * What to run for a pty request: `command` as given, or the login shell as a login shell. The env is
 * the login shell's snapshot under the app's own (already scrubbed of inherited auth) with a GUI-safe
 * PATH and a terminal's TERM/LANG, then the folder's variables (setCwdEnv); `opts.env` goes on top. `opts.systemBrowser` (sign-ins) takes it off the
 * $BROWSER shim so URLs open in the user's own browser. A missing cwd falls back to home rather than failing the spawn.
 */
function spawnSpec(opts = {}, ctx = {}) {
  const baseEnv = ctx.env ?? shellEnv.childEnv();
  const home = ctx.home ?? os.homedir();
  const isDir = ctx.isDir ?? ((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false);
  const command = Array.isArray(opts.command) && opts.command.length ? opts.command.map(String) : null;
  const win = (ctx.platform ?? process.platform) === 'win32';
  const shell = ctx.shell ?? loginShell(baseEnv, ctx.platform ?? process.platform);
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v != null && !/^ELECTRON_/.test(k)) env[k] = String(v);
  // Windows: PATH (any case, ';'-separated) is already the user's full one
  if (!win) env.PATH = [...new Set([...(env.PATH || '').split(':'), ...EXTRA_PATH].filter(Boolean))].join(':');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  if (!command && !win) env.SHELL = shell;
  const cwd = opts.cwd && isDir(opts.cwd) ? opts.cwd : home;
  const apply = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) delete env[k];
      else env[k] = String(v);
    }
  };
  apply(folderEnv(cwd, ctx.cwdEnv === undefined ? cwdEnv : ctx.cwdEnv));
  apply({ ...(opts.systemBrowser ? systemBrowserEnv(env) : {}), ...opts.env });
  const dim = (n, d) => (Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 1000) : d);
  return {
    file: command ? command[0] : shell,
    args:
      win && command && typeof opts.windowsCommandLine === 'string'
        ? opts.windowsCommandLine
        : command
          ? command.slice(1)
          : win
            ? ['-NoLogo']
            : ['-l'],
    cwd,
    env,
    cols: dim(opts.cols, 80),
    rows: dim(opts.rows, 24),
  };
}

/**
 * node-pty for `platform`. Windows: loaded from app.asar.unpacked (the whole package is unpacked there,
 * scripts/package.mjs), so its conout worker thread script and OpenConsole.exe are real files.
 * macOS's npm tarball ships spawn-helper without its exec bit, and posix_spawn needs it. Linux uses forkpty.
 */
function openPty({
  platform = process.platform,
  arch = process.arch,
  fsm = fs,
  load = require,
  dir = path.dirname(require.resolve('node-pty/package.json')).replace(/\bapp\.asar\b(?!\.unpacked)/, 'app.asar.unpacked'),
} = {}) {
  if (platform === 'win32') return load(fsm.existsSync(dir) ? dir : 'node-pty');
  const mod = load('node-pty');
  if (platform !== 'darwin') return mod;
  const helper = path.join(dir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  try {
    fsm.accessSync(helper, fsm.constants.X_OK);
  } catch {
    try {
      fsm.chmodSync(helper, 0o755);
    } catch (error) {
      // read-only install: spawn reports the error if the helper really cannot run
      noteIgnored("make the terminal's spawn helper executable", error);
    }
  }
  return mod;
}

let nodePty = null;
const loadPty = () => (nodePty ||= openPty());

/** How much recent output a pty keeps for main-process readers (the chat terminal tools), in characters. */
const TAIL_MAX = 64 * 1024;
/**
 * ConPTY's question to the terminal on Windows when it starts (DA1, "what are you?"), and the answer a terminal view
 * (xterm.js) gives it. ConPTY holds the program's start for it, about 3 s when no answer comes, so a pty no interactive
 * view answers for (a `!cmd`, a setup script, an agent's terminal command, a harness install shown read-only, a phone's
 * terminal) answers it itself, once: ConPTY asks only at start. A later DA1 in the output is the program's own (a query it
 * sends, or bytes it prints), and an answer to it would reach the program as typed input.
 */
// eslint-disable-next-line no-control-regex
const DEVICE_ATTRIBUTES = /\x1b\[0?c/;
const DEVICE_ATTRIBUTES_REPLY = '\x1b[?1;2c';
/** What the terminal view sends back by itself: cursor position and device attribute reports, focus events, OSC/DCS replies. */
// eslint-disable-next-line no-control-regex
const QUERY_REPLY = /^\x1b(?:\[[0-9;?>]*[Rc]|\[[IO]|[\]P][^]*)$/;

/** @type {Map<string, {proc: any, shell: string, tail: string, outputAt: number, typed: boolean, onData?: (d: string) => void, onExit?: (e: {exitCode: number, signal: number | null, killed: boolean}) => void}>} */
const ptys = new Map();

/**
 * Start a pty under `id`, replacing any pty already there. Returns its pid and the program it runs.
 * @param {string} id
 * @param [opts] what spawnSpec takes, and `selfAnswer`: no interactive terminal view answers for this pty, so on Windows it
 *   answers ConPTY's device-attributes question itself (DEVICE_ATTRIBUTES); an interactive view answers it for its pty,
 *   and a second answer would reach the program as typed input
 * @param {{ onData?: (data: string) => void, onExit?: (e: { exitCode: number, signal: number | null, killed: boolean }) => void }} [handlers]
 */
function spawn(id, opts = {}, handlers = {}) {
  kill(id);
  const spec = spawnSpec(opts);
  // Windows: the bundled conpty.dll, whose kill doesn't fork a helper with process.execPath as node
  // (that would launch another app instance: the RunAsNode fuse is off)
  const winOpts = process.platform === 'win32' ? { useConptyDll: true } : {};
  const run = require('./disclaim.cjs').wrap(spec.file, spec.args);
  const proc = loadPty().spawn(run.command, run.args, {
    name: 'xterm-256color',
    cwd: spec.cwd,
    env: spec.env,
    cols: spec.cols,
    rows: spec.rows,
    ...winOpts,
  });
  const entry = { proc, shell: path.basename(spec.file), tail: '', outputAt: Date.now(), typed: false, ...handlers };
  ptys.set(id, entry);
  // Output stops once a pty is killed or replaced; its exit is still reported, marked `killed`.
  // the first question only: ConPTY's start-up one (DEVICE_ATTRIBUTES)
  let answers = !!opts.selfAnswer && process.platform === 'win32';
  proc.onData((d) => {
    if (ptys.get(id) !== entry) return;
    if (answers && DEVICE_ATTRIBUTES.test(d)) {
      answers = false;
      proc.write(DEVICE_ATTRIBUTES_REPLY);
    }
    entry.tail = (entry.tail + d).slice(-TAIL_MAX);
    entry.outputAt = Date.now();
    entry.onData?.(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    const killed = ptys.get(id) !== entry;
    if (!killed) ptys.delete(id);
    entry.onExit?.({ exitCode, signal: signal || null, killed });
  });
  return { pid: proc.pid, file: spec.file };
}

const write = (id, data) => ptys.get(id)?.proc.write(String(data));
function resize(id, cols, rows) {
  const p = ptys.get(id);
  if (!p || !(cols >= 1 && rows >= 1)) return;
  try {
    p.proc.resize(Math.floor(cols), Math.floor(rows));
  } catch (error) {
    // the pty may have exited between the lookup and the resize
    noteIgnored('resize a terminal', error);
  }
}
/** Kill and forget a pty; its onExit still fires. */
function kill(id) {
  const p = ptys.get(id);
  if (!p) return false;
  ptys.delete(id);
  try {
    p.proc.kill();
  } catch (error) {
    // the pty already exited
    noteIgnored('stop a terminal', error, ['ESRCH']);
  }
  return true;
}
/** Stop reading a pty's output (the shell blocks once the OS buffer fills) and start again. */
const pause = (id) => ptys.get(id)?.proc.pause?.();
const resume = (id) => ptys.get(id)?.proc.resume?.();
const has = (id) => ptys.has(id);
/** Whether this pty's foreground process is something other than the shell it started (a command is running in it). */
const isRunning = (p) => {
  const fg = p.proc.process;
  return typeof fg === 'string' && !!fg && path.basename(fg).replace(/^-/, '') !== p.shell;
};
/**
 * What main knows of a pty: its recent output (raw, up to TAIL_MAX characters), when it last printed, whether the user
 * typed in it (keys from the terminal view, not its automatic replies) and whether a command is running in it; null when
 * there is no such pty.
 */
function info(id) {
  const p = ptys.get(id);
  return p ? { tail: p.tail, outputAt: p.outputAt, typed: p.typed, running: isRunning(p) } : null;
}
/** Some terminal is running a command: its foreground process is not the shell it started (node-pty's `process`). */
const busy = () => [...ptys.values()].some(isRunning);
function killAll() {
  for (const id of [...ptys.keys()]) kill(id);
}

/**
 * platform:pty:* IPC. Ids are the renderer's own, scoped to its webContents; output and exit arrive on
 * platform:pty:event, coalesced per tick. A window's ptys die with it (closed or reloaded).
 */
function register(ipcMain) {
  const watched = new Set();
  const keyOf = (sender, id) => `wc${sender.id}:${String(id)}`;
  const watch = (sender) => {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    const prefix = `wc${sender.id}:`;
    const drop = () => {
      for (const k of [...ptys.keys()]) if (k.startsWith(prefix)) kill(k);
    };
    sender.on('did-navigate', drop);
    sender.once('destroyed', () => {
      watched.delete(sender.id);
      drop();
    });
  };
  ipcMain.handle('platform:pty:spawn', (e, id, opts) => {
    const sender = e.sender;
    watch(sender);
    const key = keyOf(sender, id);
    let buf = '';
    let entry;
    const send = (evt) => !sender.isDestroyed() && sender.send('platform:pty:event', { id, ...evt });
    const flush = (exited = false) => {
      const data = buf;
      buf = '';
      // A queued flush may outlive a kill, replacement or window navigation.
      if (data && (exited || ptys.get(key) === entry)) send({ type: 'data', data });
    };
    const result = spawn(key, opts, {
      onData: (d) => {
        if (!buf) setImmediate(flush);
        buf += d;
      },
      // The renderer killed (or replaced) it itself and has stopped listening for this one.
      onExit: ({ exitCode, signal, killed }) => {
        if (killed) return;
        flush(true);
        send({ type: 'exit', exitCode, signal });
      },
    });
    entry = ptys.get(key);
    return result;
  });
  ipcMain.on('platform:pty:write', (e, id, data) => {
    const key = keyOf(e.sender, id);
    // the terminal view also answers the shell's queries (cursor position, focus, attributes) on its own: those are
    // not typing; keys, arrows and pastes are
    const entry = ptys.get(key);
    if (entry && !QUERY_REPLY.test(String(data))) entry.typed = true;
    write(key, data);
  });
  ipcMain.on('platform:pty:resize', (e, id, cols, rows) => resize(keyOf(e.sender, id), cols, rows));
  ipcMain.handle('platform:pty:kill', (e, id) => kill(keyOf(e.sender, id)));
}

module.exports = {
  DEVICE_ATTRIBUTES_REPLY,
  register,
  spawn,
  write,
  resize,
  kill,
  pause,
  resume,
  has,
  info,
  busy,
  killAll,
  spawnSpec,
  loginShell,
  openPty,
  setCwdEnv,
};

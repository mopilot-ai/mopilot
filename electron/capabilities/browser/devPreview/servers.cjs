// Chat-owned preview server processes, readiness polling, output history and shutdown.
const { proc: childProcess } = require('../../../platform/ports/proc.cjs');
const crypto = require('node:crypto');
const path = require('node:path');
const { oneLine } = require('../host.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { ToolError } = require('../../contract/registry.cjs');
const { clip } = require('../../../../shared/clippedText.mjs');
const { getEnv, launchSpec, pathLookup, realIo, endWindowsTree } = require('../../../platform/winbin.cjs');
const { stripAnsi, findLocalUrl, portOf, probePort, READY_MS } = require('./launch.cjs');
const { SavedPreviews } = require('./saved.cjs');

const MAX_LINES = 2000;
const MAX_PER_CHAT = 5;
const POLL_MS = 500;
const KILL_MS = 3_000;
const ERROR_LINE = /error|exception|failed|fatal/i;
class DevPreviews {
  /**
   * @param {{ spawn?: typeof childProcess.spawn, probe?: (port: number, host: string) => Promise<boolean>,
   *           env?: () => Record<string, string>, chatEnv?: (chatId: string) => Record<string, string>,
   *           platform?: string, now?: () => number, pollMs?: number, killMs?: number, maxLines?: number,
   *           maxPerChat?: number, onReady?: (server: any) => void, onExit?: (server: any) => void,
   *           io?: { exists: (p: string) => boolean, readFile: (p: string) => string | null },
   *           stateFile?: string, canRestore?: (record: any) => Promise<boolean> }} [o]
   */
  constructor(o = {}) {
    this.spawnFn = o.spawn ?? childProcess.spawn;
    this.io = o.io ?? realIo();
    this.probe = o.probe ?? ((port, host) => probePort(port, { host }));
    this.env = o.env ?? (() => ({ ...process.env }));
    this.chatEnv = o.chatEnv ?? (() => ({}));
    this.platform = o.platform ?? process.platform;
    this.now = o.now ?? Date.now;
    this.saved = o.stateFile ? new SavedPreviews(o.stateFile) : null;
    this.canRestore = o.canRestore ?? (async () => true);
    this.closing = false;
    this.pollMs = o.pollMs ?? POLL_MS;
    this.killMs = o.killMs ?? KILL_MS;
    this.maxLines = o.maxLines ?? MAX_LINES;
    this.maxPerChat = o.maxPerChat ?? MAX_PER_CHAT;
    this.onReady =
      o.onReady ??
      (() => {
        /* no ready listener */
      });
    this.onExit =
      o.onExit ??
      (() => {
        /* no exit listener */
      });
    /**
     * a server was added (starting, or attached) or stopped: the session rail reads its list (electron/app/ipc/previews.cjs)
     * @type {(server: any) => void}
     */
    this.onChange = () => {
      /* no change listener */
    };
    /** server id -> server */
    this.servers = new Map();
    /** servers stopped (SIGTERM sent) whose process hasn't exited yet */
    this.dying = new Set();
  }

  /** The chat's servers, oldest first. */
  list(chatId) {
    return [...this.servers.values()].filter((s) => s.chatId === chatId);
  }

  /** One of the chat's servers; throws for another chat's or an unknown id. */
  get(chatId, id) {
    const s = this.servers.get(String(id));
    if (!s || s.chatId !== chatId)
      throw new ToolError(`No preview server ${oneLine(id, 80)} in this chat. Call preview_list to see this chat's servers.`, 'bad_args');
    return s;
  }

  /**
   * A running server of the chat for the same thing (a configuration's name, or command and folder).
   * @param {string} chatId
   * @param {{ name?: string | null, command?: string | null, cwd?: string | null, url?: string | null }} key
   */
  find(chatId, { name = null, command = null, cwd = null, url = null }) {
    return (
      this.list(chatId).find(
        (s) => s.live && (name ? s.name === name : command ? s.display === command && s.cwd === cwd : s.url === url),
      ) ?? null
    );
  }

  #log(s, stream, text) {
    for (const line of stripAnsi(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      s.lines.push({ at: this.now(), stream, text: clip(line, 2000) });
    }
    if (s.lines.length > this.maxLines) s.lines.splice(0, s.lines.length - this.maxLines);
    if (!s.port && !s.url) {
      const found = findLocalUrl(text);
      if (found) {
        s.url = found;
        s.port = portOf(found);
      }
    }
  }

  #add(chatId, init) {
    if (this.list(chatId).filter((s) => s.live).length >= this.maxPerChat)
      throw new ToolError(`This chat already runs ${this.maxPerChat} preview servers. Stop one with preview_stop first.`, 'limit');
    const s = {
      id: `srv_${crypto.randomBytes(3).toString('hex')}`,
      chatId,
      name: null,
      display: null,
      cwd: null,
      port: null,
      url: null,
      status: 'starting',
      live: true,
      pid: null,
      proc: null,
      exited: false,
      exitCode: null,
      signal: null,
      startedAt: this.now(),
      lines: [],
      waiters: new Set(),
      timer: null,
      tabId: null,
      autoOpen: false,
      ...init,
    };
    this.servers.set(s.id, s);
    this.#changed(s);
    return s;
  }

  /**
   * What spawn runs for `file args`. On Windows a name (npm) or a path without its extension (node_modules\.bin\vite)
   * is found as the shell would, on the server's PATH or in its folder, and a .cmd shim runs through its program
   * or cmd.exe (winbin.cjs): spawn finds neither by itself.
   * @returns {[string, string[], any]}
   */
  #launch(file, args, options) {
    if (this.platform !== 'win32') return [file, args, options];
    const win = path.win32;
    const io = { ...this.io, platform: 'win32', env: options.env };
    const inFolder = /[\\/]/.test(file);
    const full = inFolder ? win.resolve(options.cwd, file) : file;
    const where = inFolder ? { PATH: win.dirname(full), PATHEXT: getEnv(options.env, 'PATHEXT') } : options.env;
    const bin = pathLookup(inFolder ? win.basename(full) : file, where).find((p) => io.exists(p)) ?? file;
    const s = launchSpec(bin, args, options, io);
    return [s.command, s.args, s.options];
  }

  /**
   * Starts a server: `run` is [file, ...args] for a configuration or [shell, -c, command] for a command.
   * Its env is the login shell's, the chat's (the $BROWSER shim), the configuration's, then PORT. `verbatim`: the
   * arguments go to cmd.exe as written (Node would escape their quotes as \", which cmd doesn't read).
   */
  start(chatId, { name = null, run, display, cwd, port = null, url = null, env = {}, verbatim = false, project = null }, id = undefined) {
    const launch = { name, run, display, cwd, port, url, env, verbatim, project };
    const s = this.#add(chatId, { ...(id ? { id } : {}), name, display, cwd, port: port ?? (url ? portOf(url) : null), url, launch });
    /** @type {Record<string, string | undefined>} */
    const childEnv = { ...this.env(), ...this.chatEnv(chatId), ...env };
    if (port) childEnv.PORT = String(port);
    let proc;
    try {
      // its own process group: stopping it stops what it launched (npm run dev -> vite)
      proc = this.spawnFn(
        ...this.#launch(run[0], run.slice(1), {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: this.platform !== 'win32',
          windowsHide: true,
          ...(verbatim ? { windowsVerbatimArguments: true } : {}),
        }),
      );
    } catch (e) {
      this.servers.delete(s.id);
      throw new ToolError(`Couldn't start ${oneLine(display, 200)}: ${oneLine(e?.message || e, 300)}`, 'failed');
    }
    s.proc = proc;
    s.pid = proc.pid ?? null;
    proc.stdout?.on('data', (d) => this.#log(s, 'stdout', d));
    proc.stderr?.on('data', (d) => this.#log(s, 'stderr', d));
    proc.on('error', (e) => {
      this.#log(s, 'system', `Couldn't run ${display}: ${e?.message || e}`);
      this.#exited(s, null, null);
    });
    proc.on('exit', (code, signal) => this.#exited(s, code, signal));
    this.#log(s, 'system', `$ ${display}${cwd ? `  (in ${cwd})` : ''}`);
    this.#poll(s);
    return s;
  }

  /** A server someone else runs (a terminal, another app): only its URL is known. */
  attach(chatId, url) {
    const s = this.#add(chatId, { display: url, url, port: portOf(url) });
    this.#log(s, 'system', `Attached to ${url} (not started by MoPilot, so preview_stop only forgets it).`);
    this.#poll(s);
    return s;
  }

  #poll(s) {
    clearTimeout(s.timer);
    // stopped (or exited) while the last probe ran
    if (!s.live) return;
    s.timer = setTimeout(async () => {
      // no URL yet, or an unparsable one: probe localhost
      const host = s.url && URL.canParse(s.url) ? new URL(s.url).hostname.replace(/^\[|\]$/g, '') : 'localhost';
      if (s.port && (await this.probe(s.port, host))) {
        if (!s.live) return;
        s.status = 'ready';
        s.url ??= `http://localhost:${s.port}/`;
        this.#log(s, 'system', `Ready at ${s.url}`);
        this.remember(s);
        this.#settle(s, 'ready');
        try {
          this.onReady(s);
        } catch (error) {
          // a listener error must not undo the ready state
          noteIgnored('tell the listener a dev server is ready', error);
        }
        return;
      }
      this.#poll(s);
    }, this.pollMs);
    s.timer.unref?.();
  }

  #settle(s, outcome) {
    for (const w of s.waiters) w(outcome);
    s.waiters.clear();
  }

  #exited(s, code, signal) {
    if (s.exited) return;
    s.exited = true;
    this.dying.delete(s);
    clearTimeout(s.timer);
    s.exitCode = code;
    s.signal = signal;
    // a server stopped on purpose stays 'stopped'; one that served and quit 'exited'; else 'failed'
    if (s.status !== 'stopped') s.status = code === 0 || s.status === 'ready' ? 'exited' : 'failed';
    s.live = false;
    this.#log(s, 'system', `Exited${code != null ? ` with code ${code}` : signal ? ` (${signal})` : ''}.`);
    this.#settle(s, 'exited');
    try {
      this.onExit(s);
    } catch (error) {
      // a listener error must not undo the exited state
      noteIgnored('tell the listener a dev server exited', error);
    }
  }

  /** Resolves 'ready', 'exited', 'timeout' or 'aborted'. */
  waitReady(s, /** @type {{ timeoutMs?: number, signal?: AbortSignal | null }} */ { timeoutMs = READY_MS, signal = null } = {}) {
    if (s.status === 'ready') return Promise.resolve('ready');
    if (!s.live) return Promise.resolve('exited');
    return new Promise((resolve) => {
      const done = (outcome) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        s.waiters.delete(done);
        resolve(outcome);
      };
      const onAbort = () => done('aborted');
      const t = setTimeout(() => done('timeout'), timeoutMs);
      t.unref?.();
      s.waiters.add(done);
      if (signal?.aborted) return done('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Stops a server (its whole process group); an attached one is only forgotten. */
  stop(chatId, id) {
    const s = this.get(chatId, id);
    this.saved?.forget((r) => r.id === id && r.chatId === chatId);
    this.#kill(s);
    this.servers.delete(s.id);
    this.#changed(s);
    return s;
  }

  #changed(s) {
    try {
      this.onChange(s);
    } catch (error) {
      // a listener error must not undo the change
      noteIgnored("tell the listener a chat's dev servers changed", error);
    }
  }

  #kill(s) {
    clearTimeout(s.timer);
    if (!s.live) return;
    if (!s.proc) {
      s.live = false;
      s.status = 'stopped';
      return this.#settle(s, 'exited');
    }
    this.#signal(s, 'SIGTERM');
    if (this.platform !== 'win32') {
      const t = setTimeout(() => !s.exited && this.#signal(s, 'SIGKILL'), this.killMs);
      t.unref?.();
    }
    // the exit event marks it stopped; until then it no longer counts as the chat's, but killNow still reaches it
    this.dying.add(s);
    s.live = false;
    s.status = 'stopped';
    this.#settle(s, 'exited');
  }

  /** Signals a server's whole process group (Windows: its process tree); the process alone when there is no group. */
  #signal(s, sig) {
    const pid = s.pid;
    if (this.platform === 'win32') {
      endWindowsTree(pid, () => {
        try {
          process.kill(pid);
        } catch (error) {
          // the process may already be gone
          noteIgnored('stop a dev server', error, ['ESRCH']);
        }
      });
      return;
    }
    try {
      // never kill(0) or kill(-1): without a pid there is no group of its own to signal
      if (!(Number.isInteger(pid) && pid > 1)) throw new Error('no pid');
      process.kill(-pid, sig);
    } catch {
      try {
        s.proc.kill(sig);
      } catch (error) {
        // the process already exited
        noteIgnored('signal a dev server process', error);
      }
    }
  }

  /**
   * The process is exiting (app quit, or main going down): every server still running, or stopped but not
   * gone yet, is killed now (SIGKILL), synchronously; no timer would run after this.
   */
  killNow() {
    for (const s of [...this.servers.values(), ...this.dying]) if (s.proc && !s.exited) this.#signal(s, 'SIGKILL');
    this.dying.clear();
  }

  /** The chat is over (archived): its servers stop. */
  stopChat(chatId) {
    if (this.saved) {
      const saved = this.saved;
      try {
        saved.forget((r) => r.chatId === chatId);
      } catch (error) {
        // Archival already committed: a failed recipe write cannot keep its process or other chat grants alive.
        noteIgnored("forget an archived chat's saved previews", error);
        for (const [id, record] of saved.records) if (record.chatId === chatId) saved.records.delete(id);
      }
    }
    for (const s of this.list(chatId)) {
      this.#kill(s);
      this.servers.delete(s.id);
    }
  }

  /** The app quits: every server stops. */
  stopAll({ preserveSaved = false } = {}) {
    if (preserveSaved) this.closing = true;
    else this.saved?.forget(() => true);
    for (const s of [...this.servers.values()]) this.#kill(s);
    this.servers.clear();
  }

  /** The page being reopened may need its previously approved local process first. */
  prepare(chatId, url) {
    return this.saved?.prepare(this, chatId, url) ?? null;
  }

  /** A ready server's save failure remains visible, and a later preview_start can retry it. */
  remember(s) {
    try {
      this.saved?.remember(s);
      s.restoreError = null;
    } catch (error) {
      s.restoreError = 'This preview is running, but its launch details could not be saved for an app restart.';
      this.#log(s, 'system', s.restoreError);
      noteIgnored('save a preview launch recipe', error);
    }
  }

  /** A server's output lines: `level` 'error' keeps lines that read as errors; `search` keeps lines containing it. */
  logs(s, { level = 'all', search = null, lines = 50 } = {}) {
    let list = s.lines;
    if (level === 'error') list = list.filter((l) => l.stream !== 'system' && ERROR_LINE.test(l.text));
    if (search) list = list.filter((l) => l.text.toLowerCase().includes(String(search).toLowerCase()));
    return list.slice(-Math.max(1, Math.min(500, Math.round(lines) || 50)));
  }
}

module.exports = { DevPreviews };

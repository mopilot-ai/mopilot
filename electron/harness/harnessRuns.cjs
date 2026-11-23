// Harness install and update commands run as child processes main owns (with foreground logs or quietly, for Update all), so a run outlives
// the window and page that started it and every window shows the same one: one run per harness, one per package
// manager across harnesses (two global npm installs at once corrupt each other's folders), its output kept for a
// window that attaches later. Once it exits the harness is looked for again (afterExit), and windows hear the run's
// end only after that.
const { clock } = require('../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { installArgv, installGroup, installMethod, packageExecutionBlock } = require('../../shared/harnessInstall.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** Output kept per run for a window that attaches later; older output drops off the front. */
const OUTPUT_MAX = 256 * 1024;

/**
 * @typedef {{ id: string, kind: string, purpose: 'install' | 'update', via: string, command: string,
 *   group: 'npm' | 'brew' | null, quiet: boolean, state: 'running' | 'exited', code: number | null, stopped: boolean,
 *   checked: boolean, startedAt: number, endedAt: number | null }} RunView
 * @typedef {RunView & { output: string, end: number, handle: { kill: () => void } | null }} Run
 * @typedef {{ ok: true, run: RunView, joined: boolean } | { ok: false, error: 'unknown' | 'busy' | 'spawn', by?: string, message?: string }} StartResult
 */

/** @param {Run} r @returns {RunView} what windows see of a run (its output comes through attach and data) */
const view = ({ output: _o, end: _e, handle: _h, ...r }) => ({ ...r });

class HarnessRuns {
  /**
   * @param {{
   *   pty: { spawn: (id: string, opts: object, handlers: object) => unknown, write: (id: string, d: string) => void,
   *     resize: (id: string, cols: number, rows: number) => void, kill: (id: string) => void },
   *   home: () => string,
   *   platform?: string,
   *   broadcast: (channel: string, payload: unknown) => void,
   *   afterExit: (kind: string) => Promise<unknown>,
   *   spawnQuiet?: (argv: string[], o: { cwd: string, env?: Record<string, string> | null, timeoutMs?: number },
   *     handlers: { onData: (d: string) => void, onExit: (e: { exitCode: number | null }) => void, onStopping?: () => void }) => { kill: () => void },
   *   now?: () => number,
   *   defer?: (fn: () => void) => void,
   * }} o
   */
  constructor(o) {
    this.o = { platform: process.platform, now: () => clock.now(), defer: setImmediate, ...o };
    /** @type {Map<string, Run>} */
    this.runs = new Map();
    /** @type {Set<(run: RunView) => void>} */
    this.ended = new Set();
    /** the harness updates that go through these runs (electron/app/ipc/harnessUpdates.cjs), once registered */
    /** @type {unknown} */
    this.updates = null;
    this.closed = false;
    /** @type {Promise<void> | null} */
    this.draining = null;
  }

  /** @returns {RunView[]} */
  list() {
    return [...this.runs.values()].map(view);
  }

  /** @param {(r: Run) => boolean} fn */
  find(fn) {
    return [...this.runs.values()].find(fn) ?? null;
  }

  publish() {
    this.o.broadcast('harnessRuns:state', this.list());
  }

  /**
   * Run line `index` of `kind`'s install table. A run of that harness already under way is joined, not started
   * twice; one of the same package manager for another harness makes this one wait (`busy`, naming it).
   * @returns {StartResult}
   */
  start(kind, index, size = {}) {
    const m = installMethod(String(kind), index, this.o.platform);
    if (!m) return { ok: false, error: 'unknown' };
    const command = m.command;
    return this.launch({ kind, purpose: 'install', via: m.via, command, argv: installArgv(command, this.o.platform) }, size);
  }

  /**
   * Run `spec` under the same rules as an install: one run per harness (a second start joins it), one per package
   * manager. In a terminal windows attach to, or quietly (stdin closed, output kept) for an update nobody watches.
   * @param {{ kind: string, purpose: 'install' | 'update', via: string, command: string, argv: string[],
   *   env?: Record<string, string> | null, cwd?: string, quiet?: boolean, timeoutMs?: number }} spec
   * @returns {StartResult}
   */
  launch(spec, size = {}) {
    if (this.closed) return { ok: false, error: 'spawn', message: 'Harness installations are closing.' };
    const blocked = packageExecutionBlock(this.o.platform);
    if (blocked) return { ok: false, error: 'spawn', message: blocked };
    const { kind } = spec;
    const running = this.find((r) => r.kind === kind && r.state === 'running');
    if (running) return { ok: true, run: view(running), joined: true };
    const group = installGroup(spec.via);
    const other = group && this.find((r) => r.group === group && r.state === 'running');
    if (other) return { ok: false, error: 'busy', by: other.kind };
    /** @type {Run} */
    const run = {
      id: `harness-run:${crypto.randomUUID()}`,
      kind,
      purpose: spec.purpose,
      via: spec.via,
      command: spec.command,
      group,
      quiet: !!spec.quiet,
      state: 'running',
      code: null,
      stopped: false,
      checked: false,
      startedAt: this.o.now(),
      endedAt: null,
      output: '',
      end: 0,
      handle: null,
    };
    let pending = '';
    const flush = () => {
      const data = pending;
      pending = '';
      if (data) this.o.broadcast('harnessRuns:data', { id: run.id, data, end: run.end });
    };
    const handlers = {
      onStopping: () => {
        if (run.state === 'running' && !run.stopped) {
          run.stopped = true;
          this.publish();
        }
      },
      onData: (/** @type {string} */ d) => {
        run.output = (run.output + d).slice(-OUTPUT_MAX);
        run.end += d.length;
        if (!pending) this.o.defer(flush);
        pending += d;
      },
      onExit: (/** @type {{ exitCode: number | null }} */ { exitCode }) => {
        flush();
        if (run.state === 'running') void this.finish(run, run.stopped ? null : exitCode);
      },
    };
    const cwd = spec.cwd ?? this.o.home();
    try {
      if (spec.quiet) {
        if (!this.o.spawnQuiet) throw new Error('quiet runs are not set up here');
        run.handle = this.o.spawnQuiet(spec.argv, { cwd, env: spec.env, timeoutMs: spec.timeoutMs }, handlers);
      }
      // shown read-only (InstallLines, RegistryInstallOutput), so no view answers ConPTY's start-up question (pty.cjs)
      else
        this.o.pty.spawn(run.id, { command: spec.argv, cwd, env: spec.env, cols: size.cols, rows: size.rows, selfAnswer: true }, handlers);
    } catch (error) {
      return { ok: false, error: 'spawn', message: String(/** @type {Error} */ (error)?.message ?? error) };
    }
    // a new run replaces this harness's last result
    for (const r of this.runs.values()) if (r.kind === kind) this.runs.delete(r.id);
    this.runs.set(run.id, run);
    this.publish();
    return { ok: true, run: view(run), joined: false };
  }

  /** The run has ended: windows see it exited, the harness is looked for again, then windows hear it was. */
  async finish(run, code) {
    run.state = 'exited';
    run.code = code;
    run.endedAt = this.o.now();
    this.publish();
    try {
      if (!this.closed) await this.o.afterExit(run.kind);
    } catch (error) {
      noteIgnored(`look for ${run.kind} again after its install`, error);
    }
    run.checked = true;
    this.publish();
    for (const fn of this.ended) {
      try {
        fn(view(run));
      } catch (error) {
        noteIgnored(`hear that ${run.kind}'s run ended`, error);
      }
    }
  }

  /** `fn(run)` hears each run once it ended and its harness was looked for again. */
  onEnd(fn) {
    this.ended.add(fn);
    return () => this.ended.delete(fn);
  }

  /** The output a run kept ('' for one this service no longer has). */
  outputOf(id) {
    return this.runs.get(String(id))?.output ?? '';
  }

  /** A run and the output it kept, `end` being how much output it had in all (data events carry theirs). */
  attach(id) {
    const r = this.runs.get(String(id));
    return r ? { run: view(r), output: r.output, end: r.end } : null;
  }

  /** Typing and size go to a running terminal; a quiet run has neither. */
  write(id, data) {
    const r = this.runs.get(String(id));
    if (r?.state === 'running' && !r.quiet) this.o.pty.write(r.id, String(data));
  }

  resize(id, cols, rows) {
    const r = this.runs.get(String(id));
    if (r?.state === 'running' && !r.quiet) this.o.pty.resize(r.id, cols, rows);
  }

  /** Stop a run: its exit still comes through and the harness is still looked for (it may have got far enough). */
  stop(id) {
    const r = this.runs.get(String(id));
    if (r?.state !== 'running') return false;
    if (r.stopped) {
      // Quiet retirement coalesces pending requests; an explicitly repeated Stop may retry a failed verification.
      if (r.handle) r.handle.kill();
      else this.o.pty.kill(r.id);
      return false;
    }
    r.stopped = true;
    this.publish();
    if (r.handle) r.handle.kill();
    else this.o.pty.kill(r.id);
    return true;
  }

  /** A caller that starts another method after Stop waits for the actual run and admission refresh, not the request. */
  stopAndWait(id) {
    const r = this.runs.get(String(id));
    if (!r || (r.state === 'exited' && r.checked)) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      let requested = false;
      const off = this.onEnd((run) => {
        if (run.id !== r.id) return;
        off();
        resolve(requested);
      });
      try {
        requested = this.stop(r.id);
      } catch (error) {
        off();
        reject(error);
      }
    });
  }

  /** Confirmed shutdown refuses new work and drains every run, including no-window quiet updates and pending checks. */
  close() {
    this.closed = true;
    if (this.draining) {
      for (const run of this.runs.values()) if (run.state === 'running') this.stop(run.id);
      return this.draining;
    }
    this.draining = Promise.all(
      [...this.runs.values()].filter((r) => r.state === 'running' || !r.checked).map((r) => this.stopAndWait(r.id)),
    ).then(
      () => undefined,
      (error) => {
        this.draining = null;
        throw error;
      },
    );
    return this.draining;
  }

  /** Forget an ended run's result. */
  dismiss(id) {
    const r = this.runs.get(String(id));
    if (!r || r.state === 'running') return false;
    this.runs.delete(r.id);
    this.publish();
    return true;
  }
}

module.exports = { HarnessRuns, OUTPUT_MAX };

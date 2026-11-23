// Harness updates, owned by main for every harness (Codex, Claude Code, each admitted ACP one): the version of the
// binary chats run, the newest its install channel has, and the update that channel runs, in a terminal windows
// attach to (one harness) or quietly in a row (Update all). Updates go through the harness runs (harnessRuns.cjs),
// so one runs per harness and one per package manager; a harness with chats mid-turn waits for them when asked to.
// After an update the harness is read again: unchanged, failed and broken updates say so. Works with no window open.
const { clock } = require('../platform/ports/clock.cjs');
const { compareVersions } = require('./versions.cjs');
const { parseVersion } = require('./latestVersion.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');
const { stripAnsi } = require('../../shared/ansiText.mjs');
const { packageExecutionBlock } = require('../../shared/harnessInstall.mjs');

/** How often a harness with chats mid-turn is looked at again while an update waits for them. */
const IDLE_POLL_MS = 2_000;
/** The daily check, with up to an hour of jitter so every install doesn't ask at once. */
const DAY_MS = 24 * 3600_000;

/** The last lines of a run's output with something on them, without colours. */
function lastLines(text, n = 3) {
  const lines = stripAnsi(text)
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-n).join(' · ');
}

/**
 * @typedef {import('./installMethod.cjs').Method} Method
 * @typedef {{ kind: string, bin: string, version: string | null }} Installed
 * @typedef {{ result: 'updated' | 'unchanged' | 'failed' | 'broken', from: string | null, to: string | null,
 *   message: string, runId?: string | null }} Outcome
 * @typedef {{ harness: string, bin: string, installed: string | null, latest: string | null,
 *   via: string, from: string, command: string | null, updatable: boolean, blockedReason: string | null,
 *   latestStatus: string | null, checkedAt: number | null, state: 'idle' | 'waiting' | 'updating',
 *   waitingFor: number, runId: string | null, retrying: boolean, outcome: Outcome | null }} Info
 * @typedef {{ running: boolean, queue: string[], total: number, index: number, current: string | null,
 *   results: { harness: string, outcome: Outcome | null }[], cancelled: boolean }} UpdateAll
 */

class HarnessUpdates {
  /**
   * @param {{
   *   runs: InstanceType<typeof import('./harnessRuns.cjs').HarnessRuns>,
   *   installed: () => Promise<Installed[]>,
   *   method: (kind: string, bin: string) => Method,
   *   latest: ReturnType<typeof import('./latestVersion.cjs').createLatest>,
   *   versionStatus: (kind: string, version: string) => string | null,
   *   readVersion: (m: Method, bin: string) => Promise<string | null>,
   *   health: (bin: string, env: Record<string, string> | null) => Promise<{ version: string | null, broken: string | null }>,
   *   busyChats: (kind: string) => { id: string, title: string }[],
   *   restart: (kind: string) => unknown,
   *   broadcast: (channel: string, payload: unknown) => void,
   *   now?: () => number,
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, random: () => number },
   * }} o
   */
  constructor(o) {
    this.o = {
      now: () => clock.now(),
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: Math.random },
      ...o,
    };
    /** @type {Map<string, Info>} */
    this.infos = new Map();
    /** @type {Map<string, Method>} */
    this.methods = new Map();
    /** an update under way per harness: its run, and the version it started from */
    /** @type {Map<string, { runId: string, before: string | null, retried: boolean }>} */
    this.pending = new Map();
    /** updates waiting for chats to finish their turns, per harness */
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.waits = new Map();
    /** Update all: what is left to run, and how it went */
    /** @type {UpdateAll | null} */
    this.all = null;
    this.checking = null;
    this.checkedAt = null;
    /** per harness, the latest read started: an older read that settles later is dropped */
    /** @type {Map<string, number>} */
    this.reads = new Map();
    /** harnesses whose long-lived process waits to restart on the new binary */
    /** @type {Set<string>} */
    this.restarting = new Set();
    this.o.runs.onEnd((run) => void this.ended(run));
  }

  /** What every window shows: one entry per installed harness, and Update all's progress. */
  state() {
    return { harnesses: [...this.infos.values()], all: this.all, checkedAt: this.checkedAt, checking: !!this.checking };
  }

  publish() {
    this.o.broadcast('harnessUpdates:state', this.state());
  }

  /**
   * Read every installed harness's version, install channel and newest version again. Checks asked at once share
   * one; `force` asks the registries again instead of their kept answers.
   */
  check({ force = false } = {}) {
    if (this.checking) return this.checking;
    // started on the next tick, so windows already see it under way when it says so
    this.checking = Promise.resolve().then(async () => {
      this.publish();
      try {
        const list = await this.o.installed();
        const seen = new Set();
        await Promise.all(
          list.map(async (h) => {
            seen.add(h.kind);
            // one harness that can't be read keeps its row as it was; the rest are read
            await this.read(h, force).catch((error) => noteIgnored(`read ${h.kind}'s version for updates`, error));
          }),
        );
        // a harness no longer installed has no row
        for (const k of [...this.infos.keys()]) if (!seen.has(k) && !this.pending.has(k)) this.infos.delete(k);
        this.checkedAt = this.o.now();
      } finally {
        this.checking = null;
        this.publish();
      }
      return this.state();
    });
    return this.checking;
  }

  /** One harness read again: how it was installed, its version, the newest there is and whether to offer it. */
  async read(h, force) {
    const gen = (this.reads.get(h.kind) ?? 0) + 1;
    this.reads.set(h.kind, gen);
    const m = this.o.method(h.kind, h.bin);
    const key = m.pkg ? this.o.latest.keyOf(m.via, m.pkg, m.cask) : null;
    if (force && key) this.o.latest.forget(key);
    const [installed, latest] = await Promise.all([
      this.o.readVersion(m, h.bin).then((v) => v ?? h.version),
      !m.pkg ? null : m.via === 'brew' ? this.o.latest.brew(m.argv?.[0] ?? 'brew', m.pkg, m.cask) : this.o.latest.npm(m.pkg),
    ]);
    const prev = this.infos.get(h.kind);
    // a read started after this one (the one after an update) has the newer answer
    if (this.reads.get(h.kind) !== gen && prev) return prev;
    this.methods.set(h.kind, m);
    const latestStatus = latest ? this.o.versionStatus(h.kind, latest) : null;
    const newer = !!installed && !!latest && compareVersions(latest, installed) > 0;
    const works = latestStatus !== 'knownBad' && latestStatus !== 'tooOld';
    const blockedReason = newer && works && m.argv && packageExecutionBlock(this.o.runs.o.platform) ? 'manual-terminal' : m.blocked;
    /** @type {Info} */
    const info = {
      harness: h.kind,
      bin: h.bin,
      installed,
      latest,
      via: m.via,
      from: m.from,
      command: m.shown,
      updatable: newer && works && !!m.argv && !blockedReason,
      blockedReason,
      latestStatus,
      checkedAt: this.o.now(),
      state: prev?.state ?? 'idle',
      waitingFor: prev?.waitingFor ?? 0,
      runId: prev?.runId ?? null,
      retrying: prev?.retrying ?? false,
      outcome: prev?.outcome ?? null,
    };
    this.infos.set(h.kind, info);
    return info;
  }

  /**
   * Update one harness. With chats mid-turn on it, `when` decides: 'now', 'idle' (waits for them), or unset (the
   * answer lists them so the window can ask). Quiet runs are Update all's.
   * @param {string} kind
   * @param {{ when?: 'now' | 'idle', quiet?: boolean }} [o]
   * @returns {Promise<{ ok: true, runId?: string, waiting?: boolean } | { ok: false, error: string, chats?: { id: string, title: string }[], by?: string, message?: string }>}
   */
  async update(kind, { when, quiet = false } = {}) {
    const info = this.infos.get(kind);
    const m = this.methods.get(kind);
    if (!info || !m?.argv || !info.updatable) return { ok: false, error: 'not-updatable' };
    if (this.pending.has(kind)) return { ok: true, runId: this.pending.get(kind)?.runId };
    const chats = this.o.busyChats(kind);
    if (chats.length && when !== 'now' && when !== 'idle') return { ok: false, error: 'chats', chats };
    if (chats.length && when === 'idle') {
      this.wait(kind, quiet);
      return { ok: true, waiting: true };
    }
    return this.launch(kind, m, info, quiet);
  }

  /** Run the update now through the harness runs, remembering what it started from. */
  launch(kind, m, info, quiet) {
    // an update that waited for idle chats and is now started another way waits no more
    const waiting = this.waits.get(kind);
    if (waiting) {
      this.o.timers.clearTimeout(waiting);
      this.waits.delete(kind);
    }
    const r = this.o.runs.launch({
      kind,
      purpose: 'update',
      via: m.via,
      command: /** @type {string} */ (m.shown),
      argv: /** @type {string[]} */ (m.argv),
      env: m.env,
      quiet,
    });
    if (!r.ok) return r;
    this.pending.set(kind, { runId: r.run.id, before: info.installed, retried: false });
    this.set(kind, { state: 'updating', runId: r.run.id, outcome: null, waitingFor: 0, retrying: false });
    return { ok: /** @type {const} */ (true), runId: r.run.id };
  }

  /** Wait for the harness's chats to finish their turns, then update it; Cancel stops waiting. */
  wait(kind, quiet) {
    this.cancelWait(kind);
    const tick = () => {
      const left = this.o.busyChats(kind).length;
      if (!left) {
        this.waits.delete(kind);
        const m = this.methods.get(kind);
        const info = this.infos.get(kind);
        if (m && info) void this.launch(kind, m, info, quiet);
        return;
      }
      this.set(kind, { state: 'waiting', waitingFor: left });
      this.waits.set(kind, this.o.timers.setTimeout(tick, IDLE_POLL_MS));
    };
    tick();
  }

  cancelWait(kind) {
    const t = this.waits.get(kind);
    if (!t) return false;
    this.o.timers.clearTimeout(t);
    this.waits.delete(kind);
    this.set(kind, { state: 'idle', waitingFor: 0 });
    return true;
  }

  set(kind, patch) {
    const info = this.infos.get(kind);
    if (!info) return;
    this.infos.set(kind, { ...info, ...patch });
    this.publish();
  }

  /** An update run ended: read the harness again and say what came of it. */
  async ended(run) {
    if (this.o.runs.closed) return;
    const p = this.pending.get(run.kind);
    if (!p || p.runId !== run.id) return;
    const m = this.methods.get(run.kind);
    const info = this.infos.get(run.kind);
    if (!m || !info) return this.settle(run.kind, null);
    const output = this.o.runs.outputOf(run.id);
    if (run.code !== 0) {
      // a sentence from its output (EACCES reads "Permission denied."); the exit code and the output stay behind Show output
      const tail = lastLines(output);
      const why = run.stopped ? ' It was stopped.' : tail ? ` ${userError(tail)}` : '';
      return this.settle(run.kind, { result: 'failed', from: p.before, to: null, message: `Didn't update.${why}` });
    }
    if (m.pkg) this.o.latest.forget(this.o.latest.keyOf(m.via, m.pkg, m.cask));
    const health = await this.o.health(info.bin, m.env);
    if (this.o.runs.closed) return;
    // npm can leave out a native package it couldn't fetch (a download that stalled) and still exit 0: once more with
    // optional packages, where the first run was (its terminal for one the person started, so the second download is
    // seen, not a silent "Updating…"; #3518), and the window says why it runs again
    if (health.broken && m.via === 'npm' && !p.retried && m.argv) {
      // pinned to the newest it was offered (an update is only offered with one), with optional packages
      const argv = [...m.argv.slice(0, -1), `${m.pkg}@${info.latest}`, '--include=optional'];
      const command = /** @type {string} */ (m.shown);
      const r = this.o.runs.launch({ kind: run.kind, purpose: 'update', via: 'npm', command, argv, env: m.env, quiet: run.quiet });
      if (r.ok) {
        this.pending.set(run.kind, { ...p, runId: r.run.id, retried: true });
        this.set(run.kind, { runId: r.run.id, retrying: true });
        return;
      }
    }
    const refreshed = await this.read({ kind: run.kind, bin: info.bin, version: health.version }, false).catch((error) => {
      noteIgnored(`read ${run.kind} again after its update`, error);
      return info;
    });
    const to = health.version ?? refreshed.installed;
    if (this.o.runs.closed) return;
    if (health.broken)
      return this.settle(run.kind, {
        result: 'broken',
        from: p.before,
        to,
        message: `Updated but won't start: ${health.broken}. Reinstall with ${m.shown}`,
      });
    // an update starts only from a known version (`updatable` needs one), so `p.before` is there
    const before = /** @type {string} */ (p.before);
    if (to && compareVersions(to, before) <= 0 && refreshed.latest && compareVersions(refreshed.latest, to) > 0)
      return this.settle(run.kind, {
        result: 'unchanged',
        from: before,
        to,
        // a CLI's own updater may follow a slower channel than the package's newest
        message:
          m.via === 'self'
            ? `Still ${to} after ${m.shown}: its updater may follow a slower channel than ${refreshed.latest}`
            : `Still ${to} after ${m.shown}; ${refreshed.latest} is out`,
      });
    this.restartWhenIdle(run.kind);
    return this.settle(run.kind, { result: 'updated', from: before, to, message: `Updated from ${before}` });
  }

  /** A long-lived process of the harness (Codex's app-server) moves to the new binary once no chat is mid-turn on it. */
  restartWhenIdle(kind) {
    // one wait per harness, however many updates land while its chats work
    if (this.restarting.has(kind)) return;
    this.restarting.add(kind);
    const tick = () => {
      if (this.o.runs.closed) {
        this.restarting.delete(kind);
        return;
      }
      if (this.o.busyChats(kind).length) return void this.o.timers.setTimeout(tick, IDLE_POLL_MS);
      this.restarting.delete(kind);
      try {
        this.o.restart(kind);
      } catch (error) {
        noteIgnored(`restart ${kind} on its new version`, error);
      }
    };
    tick();
  }

  settle(kind, outcome) {
    // the run it came from, whose output the window can show
    const runId = /** @type {{ runId: string }} */ (this.pending.get(kind)).runId;
    if (outcome) outcome = { ...outcome, runId };
    this.pending.delete(kind);
    this.set(kind, { state: 'idle', runId: null, outcome, retrying: false });
    if (this.all?.current === kind) this.next(outcome);
  }

  /**
   * Update every harness that has one, one at a time and quietly. A harness with chats mid-turn is left out and
   * says so. Cancel stops after the one running.
   */
  updateAll() {
    if (this.all?.running) return { ok: true };
    // one already under way, or waiting for its chats, goes on as it is
    const kinds = [...this.infos.values()]
      .filter((i) => i.updatable && !this.pending.has(i.harness) && !this.waits.has(i.harness))
      .map((i) => i.harness);
    if (!kinds.length) return { ok: false, error: 'nothing' };
    this.all = { running: true, queue: kinds, total: kinds.length, index: 0, current: null, results: [], cancelled: false };
    this.next(null);
    return { ok: true };
  }

  /** The next harness of Update all, after `outcome` of the last. */
  next(outcome) {
    // called by Update all itself, or by the settling of the harness it runs
    const all = /** @type {UpdateAll} */ (this.all);
    if (all.current) all.results.push({ harness: all.current, outcome });
    all.current = null;
    while (!all.cancelled && all.queue.length) {
      const kind = /** @type {string} */ (all.queue.shift());
      all.index += 1;
      const chats = this.o.busyChats(kind);
      if (chats.length) {
        all.results.push({
          harness: kind,
          outcome: {
            result: 'failed',
            from: null,
            to: null,
            message: `${chats.length} ${chats.length === 1 ? 'chat is' : 'chats are'} working with it`,
          },
        });
        continue;
      }
      const m = this.methods.get(kind);
      const info = this.infos.get(kind);
      const r = m && info ? this.launch(kind, m, info, true) : { ok: /** @type {const} */ (false), error: 'not-updatable' };
      if (r.ok) {
        all.current = kind;
        this.publish();
        return;
      }
      all.results.push({
        harness: kind,
        outcome: {
          result: 'failed',
          from: null,
          to: null,
          message: 'error' in r && r.error === 'busy' ? 'another update was running' : "couldn't start",
        },
      });
    }
    all.running = false;
    this.publish();
  }

  /** Stop Update all after the harness it is updating; that one is never killed. */
  cancelAll() {
    if (!this.all?.running) return false;
    this.all.cancelled = true;
    if (!this.all.current) this.next(null);
    this.publish();
    return true;
  }

  /** Check once a day, with jitter; never on the startup path (the first check waits a day). */
  schedule() {
    const { setTimeout: set, random } = this.o.timers;
    // a timer that never keeps the app (or a test) running on its own
    const arm = () => {
      this.timer = set(tick, DAY_MS + Math.floor(random() * 3600_000));
      this.timer?.unref?.();
    };
    const tick = () => {
      this.check().catch((error) => noteIgnored('check for harness updates', error));
      arm();
    };
    arm();
    return () => this.o.timers.clearTimeout(this.timer);
  }
}

module.exports = { HarnessUpdates, lastLines, parseVersion };

// Every harness's route as its own config sets it (shared/route.mjs over shared/harnessRoutes.mjs), and whether a running harness process started before that config last changed: read again when a declared file changes and on window focus, sent to every window, and kept with no window open.
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { HARNESS_ROUTES } = require('../../shared/harnessRoutes.mjs');
const { classifyRoute } = require('../../shared/route.mjs');
const { readRouteDocs, filesFor } = require('./routeReader.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {import('../../shared/route.mjs').HarnessRoute & {
 *   harness: string,
 *   changedAt: number,
 *   lastGood: import('../../shared/route.mjs').HarnessRoute | null,
 *   stale: { running: number, idle: number },
 *   effects: 'poolingOff'[],
 * }} RouteEntry
 *   changedAt: when the route last changed (the newest declared file's modification time at that read)
 */

/**
 * @param {object} o
 * @param {() => Record<string, string | undefined>} o.env the environment harnesses get (the login shell's)
 * @param {(kind: string) => import('./routeProcesses.cjs').RouteProcesses | null} o.processes each harness's running processes
 * @param {(list: RouteEntry[]) => void} o.onChange
 * @param {string} [o.home]
 * @param {string} [o.platform]
 * @param {Record<string, import('../../shared/harnessRoutes.mjs').HarnessRouteInfo>} [o.table]
 * @param {typeof readRouteDocs} [o.read]
 * @param {(dir: string, opts: { persistent: boolean }, cb: (event: string, name: string | null) => void) => import('node:fs').FSWatcher} [o.watch]
 * @param {() => number} [o.now]
 * @param {number} [o.debounceMs]
 */
function createRoutes({
  env,
  processes,
  onChange,
  home = os.homedir(),
  platform = process.platform,
  table = HARNESS_ROUTES,
  read = readRouteDocs,
  watch = fs.watch,
  now = clock.now,
  debounceMs = 300,
}) {
  /** @type {Map<string, { route: import('../../shared/route.mjs').HarnessRoute, lastGood: import('../../shared/route.mjs').HarnessRoute | null, changedAt: number }>} */
  const state = new Map();
  /** @type {Map<string, number>} each harness's newest read; an older one that finishes later is dropped */
  const generation = new Map();
  /** @type {Map<string, Promise<import('./routeProcesses.cjs').RestartResult>>} a restart running per harness */
  const restarting = new Map();
  /** @type {Map<string, import('node:fs').FSWatcher>} one watcher per folder holding a declared file */
  const watchers = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  let closed = false;

  /** Read one harness's files now and keep the answer, unless a newer read has started meanwhile. */
  async function refresh(kind) {
    const info = table[kind];
    const gen = (generation.get(kind) ?? 0) + 1;
    generation.set(kind, gen);
    const e = env();
    const { docs, mtimeMs } = await read(info, { env: e, home, platform });
    if (generation.get(kind) !== gen || closed) return false;
    const route = classifyRoute(info, docs);
    const prev = state.get(kind);
    // a file another tool is still writing reads as unknown: only a readable route moves changedAt
    const good = route.kind === 'unknown' ? (prev?.lastGood ?? null) : route;
    let changedAt = prev?.changedAt ?? mtimeMs;
    if (prev?.lastGood && route.kind !== 'unknown' && prev.lastGood.signature !== route.signature)
      // a file that went away has no modification time to go by
      changedAt = mtimeMs > prev.changedAt ? mtimeMs : now();
    state.set(kind, { route, lastGood: good, changedAt });
    attach(kind, e);
    return !prev || prev.route.signature !== route.signature || prev.changedAt !== changedAt;
  }

  /** Read every harness again; tell the windows when anything changed. */
  async function refreshAll() {
    const changed = await Promise.all(Object.keys(table).map((k) => refresh(k).catch(failed(`read ${k}'s route`))));
    if (changed.some(Boolean)) await emit();
  }

  /** @param {string} what */
  const failed = (what) => (/** @type {unknown} */ error) => {
    noteIgnored(what, error);
    return false;
  };

  /** Watch the folders of a harness's files (a file that doesn't exist yet appears in its folder). */
  function attach(kind, e) {
    for (const f of filesFor(table[kind], { env: e, home, platform })) {
      const dir = path.dirname(f.path);
      if (watchers.has(dir) || closed) continue;
      try {
        const w = watch(dir, { persistent: false }, (_event, name) => {
          if (!name) return void schedule();
          // the files as they are named now (the environment can change after the folder was watched)
          const current = env();
          for (const k of Object.keys(table))
            if (
              filesFor(table[k], { env: current, home, platform }).some(
                (g) => path.dirname(g.path) === dir && path.basename(g.path) === String(name),
              )
            )
              schedule(k);
        });
        w.on('error', () => {
          // a folder that went away: the next read watches it again once it is back
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch (error) {
        // no such folder yet: focus reads again
        noteIgnored('watch a harness config folder', error, ['ENOENT', 'ENOTDIR']);
      }
    }
  }

  /** One read per harness after a burst of writes (an editor or another tool saving several times). */
  function schedule(kind) {
    const kinds = kind ? [kind] : Object.keys(table);
    for (const k of kinds) {
      clock.clearTimeout(timers.get(k));
      timers.set(
        k,
        clock.setTimeout(() => {
          timers.delete(k);
          void refresh(k)
            .then((changed) => (changed ? emit() : undefined))
            .catch(failed(`read ${k}'s route`));
        }, debounceMs),
      );
    }
  }

  /** @returns {Promise<RouteEntry[]>} every harness read so far, with its processes that started before its route changed */
  async function list() {
    return Promise.all(
      [...state].map(async ([harness, s]) => {
        const procs = await (processes(harness)?.list() ?? Promise.resolve([])).catch((error) => {
          noteIgnored(`list ${harness}'s processes`, error);
          return [];
        });
        // a harness whose processes pick a change up by themselves has none on the old config
        const old = table[harness].appliesLive ? [] : procs.filter((p) => p.startedAt < s.changedAt);
        const running = old.filter((p) => p.busy).length;
        const effects = processes(harness)?.effects?.() ?? [];
        return {
          ...s.route,
          harness,
          changedAt: s.changedAt,
          lastGood: s.lastGood,
          stale: { running, idle: old.length - running },
          effects,
        };
      }),
    );
  }

  /** Tell the windows; a failure is logged, never left as an unhandled rejection of a watcher or startup read. */
  async function emit() {
    try {
      onChange(await list());
    } catch (error) {
      noteIgnored('send the harness routes to the windows', error);
    }
  }

  /**
   * Restart the idle processes of a harness that started before its route changed. A second call while one
   * runs gets the same answer; busy processes are left alone and counted.
   */
  function restartIdle(kind) {
    const running = restarting.get(kind);
    if (running) return running;
    const s = state.get(kind);
    const procs = processes(kind);
    const job = (async () => {
      try {
        return s && procs ? await procs.restartIdle(s.changedAt) : { restarted: 0, busy: 0 };
      } finally {
        restarting.delete(kind);
        await emit();
      }
    })();
    restarting.set(kind, job);
    return job;
  }

  function close() {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const t of timers.values()) clock.clearTimeout(t);
    timers.clear();
  }

  return { refresh, refreshAll, list, emit, restartIdle, close, get: (kind) => state.get(kind)?.route ?? null };
}

module.exports = { createRoutes };

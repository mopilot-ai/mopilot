// Ending a harness process with everything it started (POSIX, #1347): its own process group, and the group of every
// process descending from that group. Harnesses run each command in a process group of its own (Codex and Claude Code
// both do), so the harness's group alone does not reach them, and a harness that is SIGKILLed (a hang restart after
// the grace period) cannot end them itself. The tree is read from the Rust core while the processes are still linked to it.
// A harness that dies outside MoPilot (SIGKILLed, crashed) is the other case (#1486): its commands are re-parented to
// launchd the moment it goes, in groups of their own, so no walk from the harness finds them. A watch therefore records
// the descendants of a harness while it runs (one shared read every WATCH_MS while a harness is active, every
// IDLE_WATCH_MS once nothing has happened for QUIET_TICKS ticks: commands start in turns, whose events wake it), and
// what is still alive of them when the harness is gone is ended. (An environment token read back with `ps -E` was measured and does not work:
// macOS hides the environment of Apple's own binaries, /bin/zsh and /bin/sleep among them.)
const { noteIgnored } = require('../ignored.cjs');
const { coreCall } = require('./core.cjs');
const { identityTable } = require('./processIdentity.cjs');

/** How long the processes have to end after SIGTERM before what is left gets SIGKILL. */
const GROUP_GRACE_MS = 3000;

/** @typedef {[pid: number, ppid: number, pgid: number, birth?: string]} ProcRow */

/**
 * Every process: [pid, ppid, pgid], from the Rust core with no process started. Empty when its read fails (the route's
 * error, noted): then only the group itself is signalled, and a watch keeps what it recorded.
 * @param {(route: string) => Promise<any>} [call]
 * @returns {Promise<ProcRow[]>}
 */
async function processTable(call = coreCall) {
  try {
    // the route's reply is always the rows (core/crates/proc rows_json): a read that fails is its error, not another shape
    return await call('proc.table');
  } catch (error) {
    noteIgnored('read the process table', error);
    return [];
  }
}

/**
 * The process groups to end for the group `pgid`, and the processes in them: the group itself, and the group of every
 * process descending from one of its members. Never group 0 or 1, and never `own` (MoPilot's own group).
 * @param {ProcRow[]} table @param {number} pgid @param {number} own
 * @returns {{ groups: Set<number>, pids: Set<number> }}
 */
function groupsOf(table, pgid, own) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [pid, ppid] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const groupOf = new Map(table.map(([pid, , g]) => [pid, g]));
  const tree = new Set();
  const stack = table.filter(([, , g]) => g === pgid).map(([pid]) => pid);
  while (stack.length) {
    const pid = /** @type {number} */ (stack.pop());
    if (tree.has(pid)) continue;
    tree.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  const groups = new Set([pgid]);
  for (const pid of tree) groups.add(/** @type {number} */ (groupOf.get(pid)));
  for (const g of [...groups]) if (!(g > 1) || g === own) groups.delete(g);
  const pids = new Set(table.filter(([, , g]) => groups.has(g)).map(([pid]) => pid));
  return { groups, pids };
}

/** How often the watched harnesses' descendants are recorded while a harness is active. */
const WATCH_MS = 2000;
/** How often once they are quiet: no harness event and no change in any record for QUIET_TICKS ticks in a row. */
const IDLE_WATCH_MS = 30_000;
const QUIET_TICKS = 3;

/**
 * Children by parent pid.
 * @param {ProcRow[]} table
 * @returns {Map<number, number[]>}
 */
function childrenOf(table) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [pid, ppid] of table) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/**
 * The processes below `root` (not `root` itself), by pid: [pid, pgid]. Never pid 0 or 1, never MoPilot itself.
 * @param {ProcRow[]} table @param {number} root @param {Map<number, number[]>} [children] childrenOf(table), when already built
 * @returns {Map<number, number>}
 */
function descendantsOf(table, root, children = childrenOf(table)) {
  const groupOf = new Map(table.map(([pid, , g]) => [pid, g]));
  /** @type {Map<number, number>} */
  const out = new Map();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = /** @type {number} */ (stack.pop());
    if (out.has(pid) || pid <= 1 || pid === process.pid) continue;
    out.set(pid, /** @type {number} */ (groupOf.get(pid)));
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * The descendants of one harness process, as last recorded. `known` maps a pid to the group it was in; an entry stays
 * through reparenting. With a kernel birth identity, ownership also survives group changes; without one, the legacy
 * watcher drops changed groups because a reused numeric PID cannot prove ownership.
 * @typedef {{ root: number, known: Map<number, number>, births?: Map<number, string>, stopped: boolean, stop: () => void }} TreeWatch
 */

/**
 * Records the descendants of the roots it is given; one read per tick serves all of them, and the timer runs only while
 * there are roots. A tick comes every `every` ms while something happens (a harness event through wake(), or a change
 * in what is recorded), every `idleEvery` ms once QUIET_TICKS ticks in a row saw nothing happen.
 */
class TreeWatcher {
  /**
   * @param {{ table?: () => ProcRow[] | Promise<ProcRow[]>, every?: number, idleEvery?: number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [o]
   */
  constructor({
    table = processTable,
    every = WATCH_MS,
    idleEvery = IDLE_WATCH_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = {}) {
    this.table = table;
    this.every = every;
    this.idleEvery = idleEvery;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Set<TreeWatch>} */
    this.watches = new Set();
    /** @type {any} the next tick's timer, while something is watched */
    this.timer = null;
    this.polling = false;
    /** ticks in a row that saw nothing happen */
    this.quiet = 0;
    /** a harness event came since the last tick */
    this.active = false;
  }

  /** The next tick in `ms`. */
  schedule(/** @type {number} */ ms) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.run(), ms);
    this.timer?.unref?.();
  }

  /** One tick, then the next: soon while something happens, later once it has been quiet. */
  async run() {
    const changed = await this.tick();
    this.quiet = changed || this.active ? 0 : this.quiet + 1;
    this.active = false;
    if (this.watches.size) this.schedule(this.quiet >= QUIET_TICKS ? this.idleEvery : this.every);
  }

  /** A harness did something (an event reached the windows): a command it starts is recorded within `every` ms. */
  wake() {
    this.active = true;
    if (this.timer && this.quiet >= QUIET_TICKS) {
      this.quiet = 0;
      this.schedule(this.every);
    }
  }

  /** @param {number} root @returns {TreeWatch} */
  watch(root) {
    /** @type {TreeWatch} */
    const w = { root, known: new Map(), births: new Map(), stopped: false, stop: () => this.stop(w) };
    this.watches.add(w);
    // a new harness is activity: its first commands are recorded soon
    this.quiet = 0;
    if (!this.timer) this.schedule(this.every);
    return w;
  }

  /** A stopped watch keeps what it recorded (the caller reads it after the harness exited) but records no more. */
  stop(/** @type {TreeWatch} */ w) {
    w.stopped = true;
    this.watches.delete(w);
    if (!this.watches.size && this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Records what is below each root now; resolves whether any record changed. */
  async tick() {
    // a slow read is not stacked on
    if (this.polling) return false;
    this.polling = true;
    try {
      const rows = await this.table();
      // no table (ps failed): keep what was recorded
      if (!rows.length) return false;
      const groupOf = new Map(rows.map(([pid, , g]) => [pid, g]));
      const birthOf = new Map(rows.map(([pid, , , birth]) => [pid, birth]));
      const children = childrenOf(rows);
      let changed = false;
      for (const w of this.watches) {
        const descendants = descendantsOf(rows, w.root, children);
        for (const [pid, g] of descendants)
          if (w.known.get(pid) !== g) {
            w.known.set(pid, g);
            changed = true;
          }
        for (const pid of descendants.keys()) {
          const birth = birthOf.get(pid);
          if (birth) w.births?.set(pid, birth);
        }
        for (const [pid, g] of w.known) {
          const group = groupOf.get(pid);
          const birth = w.births?.get(pid);
          const current = birthOf.get(pid);
          if (group === undefined || (birth ? current && current !== birth : group !== g)) {
            w.known.delete(pid);
            w.births?.delete(pid);
            changed = true;
          } else if (group !== g) {
            w.known.set(pid, group);
            changed = true;
          }
        }
      }
      return changed;
    } finally {
      this.polling = false;
    }
  }
}

const watcher = new TreeWatcher();
const identityWatcher = new TreeWatcher({ table: identityTable });

/** A harness did something: the shared watcher records what it starts soon (app/windows.cjs calls it on each event). */
const wakeWatcher = () => watcher.wake();

/**
 * Start recording the descendants of `root` (a harness process) with the shared watcher. Windows has no process groups to read and
 * records nothing there (its commands need a Job Object, #1486).
 * @param {number} root @param {boolean} [managed] @returns {TreeWatch}
 */
function watchTree(root, managed = false) {
  if (process.platform === 'win32') return { root, known: new Map(), stopped: true, stop: () => undefined };
  return (managed ? identityWatcher : watcher).watch(root);
}

/**
 * End what was recorded below a harness that is gone: the commands it started and left running (#1486). Stops the
 * recording. Resolves false when none of them is left.
 * @param {TreeWatch} w
 * @param {Parameters<typeof signalTree>[2]} [o]
 */
function reapTree(w, o = {}) {
  w.stop();
  return w.known.size ? signalTree(null, 'SIGTERM', { ...o, known: w.known }) : Promise.resolve(false);
}

/**
 * What to signal: the groups (a leader's whole group), and the other processes one by one (a process that shares a
 * group with MoPilot or with something that is not ours is signalled alone). Both with the processes meant, for the
 * SIGKILL pass.
 * @typedef {{ groups: Set<number>, pids: Set<number>, loose: Map<number, number> }} Targets
 */

/**
 * Add the recorded descendants that are still there to `t`: a group leader brings its group, any other brings itself.
 * @param {Targets} t @param {ProcRow[]} table @param {Map<number, number>} known @param {number} own
 */
function addKnown(t, table, known, own) {
  for (const [pid, , g] of table) {
    if (known.get(pid) !== g || !(g > 1) || pid === process.pid) continue;
    if (g === pid && g !== own) {
      t.groups.add(g);
      t.pids.add(pid);
    } else t.loose.set(pid, g);
  }
  for (const g of t.groups) for (const [pid, , pg] of table) if (pg === g) t.pids.add(pid);
}

/**
 * Send `sig` to the group `pgid` and to every group descending from it (and, when `known` is given, to the recorded
 * descendants of a harness that are still alive: pgid null then), then SIGKILL what is left of them after
 * GROUP_GRACE_MS: only processes that were in them when they were signalled (a group id handed out again meanwhile is
 * someone else's). Resolves false when nothing was there to signal. The table is read before anything is signalled,
 * while every process is still linked to the tree.
 * @param {number | null} pgid @param {NodeJS.Signals} sig
 * `wait` additionally waits for the observed owned processes to disappear; signalling alone is not retirement.
 * @param {{ table?: () => ProcRow[] | Promise<ProcRow[]>, kill?: (pid: number, sig: NodeJS.Signals | 0) => void, own?: number, known?: Map<number, number>, births?: Map<number, string>, ownedGroups?: Map<number, string | null>, valid?: (group: number) => boolean, wait?: boolean }} [o]
 * @returns {Promise<boolean>}
 */
async function signalTree(
  pgid,
  sig,
  { table, kill = process.kill.bind(process), own, known, births, ownedGroups, valid, wait = false } = {},
) {
  if (wait) return require('./processRetirement.cjs').retireTree(pgid, sig, { table, kill, own, known, births, ownedGroups, valid });
  table ??= processTable;
  const rows = await table();
  const self = own ?? rows.find(([pid]) => pid === process.pid)?.[2] ?? 0;
  /** @type {Targets} */
  const t = pgid == null ? { groups: new Set(), pids: new Set(), loose: new Map() } : { ...groupsOf(rows, pgid, self), loose: new Map() };
  if (known) addKnown(t, rows, known, self);
  let signalled = false;
  /** @param {number} target */
  const send = (target) => {
    try {
      kill(target, sig);
      signalled = true;
    } catch (error) {
      // the group or process is gone (ESRCH): nothing of it is left to end
      noteIgnored('signal a harness process group', error, ['ESRCH']);
    }
  };
  for (const g of t.groups) send(-g);
  for (const pid of t.loose.keys()) send(pid);
  if (!signalled) return false;
  const late = setTimeout(async () => {
    for (const [pid, , g] of await table()) {
      // still the process that was signalled, in the group it was in
      if (!(t.pids.has(pid) && t.groups.has(g)) && t.loose.get(pid) !== g) continue;
      try {
        kill(pid, 'SIGKILL');
      } catch (error) {
        // it ended on SIGTERM meanwhile (ESRCH)
        noteIgnored('end what is left of a harness', error, ['ESRCH']);
      }
    }
  }, GROUP_GRACE_MS);
  late.unref?.();
  return true;
}

module.exports = {
  GROUP_GRACE_MS,
  WATCH_MS,
  IDLE_WATCH_MS,
  QUIET_TICKS,
  processTable,
  groupsOf,
  descendantsOf,
  signalTree,
  TreeWatcher,
  watcher,
  wakeWatcher,
  watchTree,
  reapTree,
};

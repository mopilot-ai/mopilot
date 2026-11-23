// The Codex app-server's idle recycler: it keeps a thread loaded, with that thread's MCP server processes, after its last
// client unsubscribes (thread/unsubscribe answers notSubscribed; thread/loaded/list still lists it), and the protocol
// has no request that unloads one. So an app-server that has been quiet a while and still holds loaded threads
// restarts the way Restart to apply restarts an idle one, and their processes end. Every Codex chat, managed or native,
// on either app-server: the user's, and MoMo's own (codexIsolatedServer.cjs), which is let go on its own when only it holds threads.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { restartCodexServer } = require('./routeProcesses.cjs');
const { ISOLATED_THREAD } = require('./codexIsolation.cjs');

/** How long no thread has been loaded or worked in (codexConnection.cjs USES_THREAD) before the loaded ones are let go. */
const IDLE_MS = 3 * 60_000;
const CHECK_MS = 60_000;
/** Under memory pressure (electron/platform/memoryPressure.cjs) the loaded threads go after this little quiet. */
const PRESSURE_IDLE_MS = 60_000;
/** A read the recycler sends (a read is not activity): one that does not answer in time leaves the process alone. */
const READ_MS = 10_000;

/**
 * Nothing the app-server holds is in use: no turn, lease, request (its own or one it waits on the user for), composer
 * thread, title, hidden helper turn, voice session, goal recovery or crash restart, and no Codex chat waits on the user or runs a goal.
 * @param {any} c the CodexAdapter
 * @param {() => boolean} chatsBusy
 */
function quiet(c, chatsBusy) {
  const empty = (x) => !x?.size;
  return (
    !c.down &&
    !c.restartTimer &&
    !c.recovering &&
    [c.running, c.leases, c.pending, c.heldRequests, c.prewarmed, c.titling, c.hidden, c.realtime].every(empty) &&
    !chatsBusy()
  );
}

/**
 * @param {object} o
 * @param {() => any} o.server the AppServer
 * @param {() => any} o.codex the CodexAdapter
 * @param {() => boolean} [o.chatsBusy] a Codex chat waits on the user or runs an active goal (routeProcesses.cjs)
 * @param {number} [o.idleMs]
 * @param {number} [o.checkMs]
 * @param {() => number} [o.now]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
 * @param {(line: string) => void} [o.log]
 */
function codexRecycler({
  server,
  codex,
  chatsBusy = () => false,
  idleMs = IDLE_MS,
  checkMs = CHECK_MS,
  now = clock.now,
  timers = { setInterval: clock.setInterval, clearInterval: clock.clearInterval },
  log = () => {
    /* no listener */
  },
}) {
  let timer = /** @type {any} */ (null);
  let stopped = false;
  let checking = false;
  /** When the last pressure reading ran a pass: one a minute, as the Claude Code governor sweeps. */
  let pressedAt = -Infinity;

  /** The thread ids an app-server holds loaded; null when the read failed. `mark`: asks MoMo's app-server (routed by the mark). */
  const loadedOn = async (c, mark) => {
    const r = await c.call('thread/loaded/list', mark ? { [ISOLATED_THREAD]: true } : {}, READ_MS).catch((error) => {
      noteIgnored('list the threads an idle Codex app-server holds', error);
      return null;
    });
    return Array.isArray(r?.data) ? r.data.filter((id) => typeof id === 'string') : [];
  };

  /** Whether one loaded thread runs a background terminal; a read that fails counts as one (the process stays). */
  const terminals = (c, threadId) =>
    c.call('thread/backgroundTerminals/list', { threadId }, READ_MS).then(
      (r) => (Array.isArray(r?.data) ? r.data.length : Array.isArray(r?.terminals) ? r.terminals.length : 1),
      () => 1,
    );

  /** One pass: true when it restarted the app-server. `quietFor` replaces idleMs (memory pressure). */
  async function check({ quietFor = idleMs } = {}) {
    if (stopped || checking) return false;
    checking = true;
    try {
      const s = server();
      const c = codex();
      const proc = s?.proc;
      if (!proc || !c || !quiet(c, chatsBusy)) return false;
      const since = c.lastActivity;
      if (now() - since < quietFor) return false;
      // MoMo's own app-server is asked only while it runs: asking would start it
      const iso = s.isolated?.running?.() ? s.isolated : null;
      const [mine, theirs] = await Promise.all([loadedOn(c, false), iso ? loadedOn(c, true) : []]);
      const loaded = [...mine, ...theirs];
      if (!loaded.length) return false;
      const counts = await Promise.all(loaded.map((id) => terminals(c, id)));
      if (counts.some((n) => n > 0)) return false;
      // anything that happened while it asked keeps the process: a request, a message, a quit, another restart
      if (stopped || server() !== s || s.proc !== proc || codex() !== c || c.lastActivity !== since || !quiet(c, chatsBusy)) return false;
      // a request to MoMo's app-server on its way, or a thread coming into its home, keeps both processes
      if (iso?.busy()) return false;
      if (!mine.length) {
        // only MoMo's holds threads: it alone is let go, the user's app-server and its chats are not touched
        log(`codex: restarting MoMo's idle app-server to let go of ${theirs.length} loaded thread(s)`);
        iso.recycle();
        return true;
      }
      log(`codex: restarting the idle app-server to let go of ${loaded.length} loaded thread(s)`);
      await restartCodexServer(s, c);
      return true;
    } finally {
      checking = false;
    }
  }

  return {
    check,
    start() {
      if (timer || stopped) return;
      timer = timers.setInterval(() => {
        check().catch((error) => noteIgnored('recycle an idle Codex app-server', error));
      }, checkMs);
      timer?.unref?.();
    },
    /** A memory-pressure reading: a pass now, after a minute's quiet instead of IDLE_MS. */
    onPressure(level) {
      if (!level || now() - pressedAt < PRESSURE_IDLE_MS) return;
      pressedAt = now();
      check({ quietFor: Math.min(idleMs, PRESSURE_IDLE_MS) }).catch((error) => noteIgnored('recycle Codex under memory pressure', error));
    },
    /** Quitting: no pass starts, and one under way restarts nothing. */
    stop() {
      stopped = true;
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { codexRecycler, IDLE_MS, CHECK_MS, PRESSURE_IDLE_MS };

// Codex app-servers that run threads on a credential of their own (#4667): the set that sits in the main AppServer's `isolated` slot, so one adapter sees one server while a thread's requests go to the process holding its credential. Each member is an IsolatedServer (codexIsolatedServer.cjs) that does not follow the main one's sign-ins; the set tries them in turn, and ends them with the main one.

const { clock } = require('../platform/ports/clock.cjs');

class CodexLanes {
  /** @param {InstanceType<typeof import('./codexProcess.cjs').AppServer>} main the app-server every thread outside a lane runs on */
  constructor(main) {
    this.main = main;
    /** @type {Map<string, InstanceType<typeof import('./codexIsolatedServer.cjs').IsolatedServer>>} */
    this.lanes = new Map();
    main.isolated = this;
  }

  /**
   * @param {string} key the credential the lane runs for
   * @param {InstanceType<typeof import('./codexIsolatedServer.cjs').IsolatedServer>} lane built with `attach: false`, `follows: false` and a prefix of its own
   */
  add(key, lane) {
    this.lanes.set(key, lane);
    return lane;
  }

  /** The main AppServer's send: true when a lane took the message. */
  take(obj) {
    for (const lane of this.lanes.values()) if (lane.take(obj)) return true;
    return false;
  }

  /** The process a thread's request goes to: its lane's (started now), else the main one's (a thread's tool session names it). */
  pidFor(params) {
    for (const lane of this.lanes.values()) if (lane.mine({ params })) return lane.pidFor(params);
    return this.main.proc?.pid;
  }

  /** Every lane's process now running. */
  pids() {
    return [...this.lanes.values()].flatMap((lane) => lane.pids());
  }

  /** Whether any lane's process runs (asking one something starts it, which a check of what it holds must not). */
  running() {
    return [...this.lanes.values()].some((lane) => lane.running());
  }

  /** Whether any lane has a request on its way. */
  busy() {
    return [...this.lanes.values()].some((lane) => lane.busy());
  }

  /**
   * Ends the processes of lanes that have run nothing for `idleMs`: no turn, no request on its way, nothing said either way since. Each lane's threads close,
   * and the next request for one starts its process again, so what is let go is only the memory and the open tools of a credential nobody is using.
   * @param {number} idleMs @param {number} [now]
   * @returns {number} how many lanes were ended
   */
  reapIdle(idleMs, now = clock.now()) {
    let ended = 0;
    for (const lane of this.lanes.values()) {
      if (!lane.running() || lane.turns.size > 0 || lane.busy() || now - lane.activeAt < idleMs) continue;
      lane.recycle();
      ended++;
    }
    return ended;
  }

  /** Lets go of every thread the lanes keep loaded: their processes end, and the adapter hears each thread close. */
  recycle() {
    for (const lane of this.lanes.values()) lane.recycle();
  }

  /** Goes with the main one's stop or exit: the adapter ends everything then, so nothing is told here. */
  stop() {
    for (const lane of this.lanes.values()) lane.stop();
  }
}

module.exports = { CodexLanes };

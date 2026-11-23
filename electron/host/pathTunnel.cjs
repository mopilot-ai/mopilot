// The way to one machine's Host (#2709): its SSH tunnel, its relay tunnel, or the better of the two, behind the one tunnel contract
// remote.cjs and the heartbeat already use (sshTunnel.cjs). `auto` (the default) holds both: it uses SSH whenever SSH is up and the
// relay when only the relay is, and never moves a connection that is up (a switch happens when the path in use goes down). `ssh`
// never uses the relay, so a machine the user pinned to SSH says why SSH failed instead of falling back unasked; `relay` never uses SSH.
// A lease's socket path follows the path in use, and a switch is told as `connecting` then `online`, so a connection on the old
// path is dropped (never failed) and the next one goes the new way. The relay path and the mode are read again on `sync()`, so a
// machine enrolled (or pinned) while its tunnel is held takes the change without a new tunnel.

/** @typedef {'online' | 'connecting' | 'offline'} TunnelState */
/** @typedef {'auto' | 'ssh' | 'relay'} PathMode */
/** @typedef {{ localSocket: string, state: TunnelState, reason: string, onState(fn: (s: TunnelState, why: string) => void): () => void, acquire(): { socketPath: string, ready: Promise<boolean>, release(): void }, fail(why: string): void, latencyMs?: number | null }} Tunnel */

/**
 * @param {object} o
 * @param {Tunnel} o.ssh
 * @param {() => Tunnel | null} [o.relay] the machine's relay tunnel; null: it has none (not enrolled, or no relay configured)
 * @param {() => PathMode} [o.mode]
 */
function createPathTunnel({ ssh, relay = () => null, mode = () => 'auto' }) {
  /** The tunnels this one may use now, preferred first. */
  const usable = () => {
    const r = relay();
    const m = mode();
    if (m === 'relay') return r ? [r] : [];
    return m === 'ssh' || !r ? [ssh] : [ssh, r];
  };
  /** @type {Tunnel | null} */
  let active = null;
  /** @type {TunnelState} */
  let state = 'offline';
  let reason = '';
  let refs = 0;
  /** @type {Map<Tunnel, { lease: { release(): void }, off: () => void }>} */
  const held = new Map();
  /** @type {Set<(ok: boolean) => void>} */
  const waiting = new Set();
  /** @type {Set<(s: TunnelState, why: string) => void>} */
  const listeners = new Set();

  /** @param {TunnelState} next @param {string} why */
  function setState(next, why) {
    if (next === state && why === reason) return;
    state = next;
    reason = why;
    if (next === 'online') for (const settle of [...waiting]) settle(true);
    for (const fn of [...listeners]) fn(next, why);
  }

  /** Why no path works: each path's own reason, named when there are two. @param {Tunnel[]} ts */
  const whyNot = (ts) =>
    ts.length === 0
      ? 'This machine has no relay path.'
      : ts.length === 1
        ? ts[0].reason
        : ts
            .filter((t) => t.reason)
            .map((t) => `${t === ssh ? 'SSH' : 'Relay'}: ${t.reason}`)
            .join(' · ');

  function update() {
    if (refs === 0) return setState('offline', '');
    const ts = usable();
    // the path in use stays while it is up (and still allowed)
    if (active && ts.includes(active) && active.state === 'online') return setState('online', '');
    const next = ts.find((t) => t.state === 'online') ?? null;
    if (next) {
      // a connection on the old path ends (not failed) before the next one is made on the new path
      if (active && active !== next && state === 'online') setState('connecting', 'Switching to another path.');
      active = next;
      return setState('online', '');
    }
    active = null;
    setState(ts.some((t) => t.state === 'connecting') ? 'connecting' : 'offline', whyNot(ts));
  }

  /** Holds a lease on each tunnel in use now and lets go of the rest. */
  function sync() {
    const want = refs > 0 ? usable() : [];
    for (const [t, h] of [...held]) {
      if (want.includes(t)) continue;
      h.off();
      h.lease.release();
      held.delete(t);
    }
    for (const t of want) if (!held.has(t)) held.set(t, { off: t.onState(update), lease: t.acquire() });
    update();
  }

  return {
    get localSocket() {
      return (active ?? usable()[0] ?? ssh).localSocket;
    },
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    /** The path in use now: `ssh`, `relay`, or null while none is up. @returns {'ssh' | 'relay' | null} */
    get path() {
      if (state !== 'online' || !active) return null;
      return active === ssh ? 'ssh' : 'relay';
    },
    /** The round trip through the relay while it is the path in use, else null. */
    get latencyMs() {
      return state === 'online' && active && active !== ssh ? (active.latencyMs ?? null) : null;
    },
    /** @param {(s: TunnelState, why: string) => void} fn */
    onState(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    sync,
    acquire() {
      refs++;
      let released = false;
      let settle = /** @type {(ok: boolean) => void} */ (/** @type {any} */ (null));
      const ready = new Promise((resolve) => {
        settle = (ok) => (waiting.delete(settle), resolve(ok));
      });
      waiting.add(settle);
      if (refs === 1) sync();
      else if (state === 'online') settle(true);
      const self = this;
      return {
        /** the socket of the path in use when a connection is made */
        get socketPath() {
          return self.localSocket;
        },
        ready,
        release() {
          if (released) return;
          released = true;
          settle(false);
          if (--refs === 0) sync();
        },
      };
    },
    /** The connection on the path in use broke. @param {string} why */
    fail(why) {
      active?.fail(why);
    },
    /** Lets go of every path whoever still holds a lease (Host access was lost, the app is quitting). */
    close() {
      refs = 0;
      for (const settle of [...waiting]) settle(false);
      sync();
    },
    get leases() {
      return refs;
    },
  };
}

module.exports = { createPathTunnel };

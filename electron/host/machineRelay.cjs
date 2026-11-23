// The relay path of the user's machines as machines.cjs shows and keeps it (#2709): each row's path word (Direct, Via relay and its
// round trip, or SSH for a machine with no relay path) and path facts, the relay path given to a paired machine (at pairing, and
// once more on a later heartbeat after a failure: an older Host, a relay that is down), and taken away with the machine.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { helloParams } = require('../../shared/host/schema.mjs');

/** How long after a failed try a machine is given a relay path again. */
const ENROLL_RETRY_MS = 10 * 60_000;

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./relayPaths.cjs').createRelayPaths> | null} o.relay none: SSH only, and every row says SSH
 * @param {{ list: () => any[], onChange: (fn: () => void) => () => void }} o.registry
 * @param {{ get: (target: any) => any }} o.pool
 * @param {(record: any) => any} o.targetOf
 * @param {() => boolean} o.allowed
 * @param {(record: any) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.openPaired
 * @param {() => void} o.onChange
 */
function createMachineRelay({ relay, registry, pool, targetOf, allowed, openPaired, onChange }) {
  let disposed = false;
  /** When each machine may be tried again. @type {Map<string, number>} */
  const tried = new Map();
  /** @param {any} r */
  const view = (r) => (relay && r.socketPath && allowed() ? relay.view(r.address, pool.get(targetOf(r))) : null);

  /** @param {string} id */
  /** One enrollment per machine at a time (pairing and a heartbeat may both ask). @type {Map<string, Promise<void>>} */
  const running = new Map();
  /** @param {string} id */
  function enroll(id) {
    const now = running.get(id);
    if (now) return now;
    const run = enrollOnce(id).finally(() => running.delete(id));
    running.set(id, run);
    return run;
  }
  /** @param {string} id */
  async function enrollOnce(id) {
    const record = registry.list().find((r) => r.id === id);
    // a machine with a relay path is left alone, unless its credential is still the one an install script carried (Add by command)
    if (!relay || !record || disposed || (relay.enrolled(record.address) && !relay.needsRotation(record.address))) return;
    tried.set(id, clock.now() + ENROLL_RETRY_MS);
    // the machine is still the one this ran for: removed (or added again elsewhere) meanwhile, nothing of it is kept
    const wanted = () => !disposed && registry.list().some((r) => r.id === id && r.address === record.address);
    try {
      const s = await openPaired(record);
      try {
        // the relay methods are gated on what both ends declared: an older Host is asked nothing, and no credential is made for it
        const hello = await s.call('host.hello', helloParams());
        if (Array.isArray(hello?.features) && hello.features.includes('relay'))
          await relay.enroll(record.address, (m, p) => s.call(m, p), wanted);
      } finally {
        s.close();
      }
    } catch (error) {
      noteIgnored('give a machine a relay path', error);
    }
    onChange();
  }

  const offRows = registry.onChange(() => {
    for (const r of registry.list()) if (r.status === 'online' && r.hostKey && !(clock.now() < (tried.get(r.id) ?? 0))) void enroll(r.id);
  });
  const offLane = relay?.lane.onChange(onChange);

  return {
    /** The row's path word. @param {any} r */
    note(r) {
      const v = view(r);
      if (v?.path === 'relay') return v.latencyMs === null ? 'Via relay' : `Via relay · ${v.latencyMs} ms`;
      return v?.relay ? 'Direct' : 'SSH';
    },
    /** The row's path facts (none without a relay). @param {any} r */
    row(r) {
      const v = view(r);
      return v ? { path: v } : {};
    },
    enroll,
    /** Pins a machine to a path or back to auto; a machine with no relay path can still be pinned to SSH. @param {string} id @param {unknown} mode */
    setMode(id, mode) {
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw Object.assign(new Error('That machine is not in the list.'), { code: 'unknown_machine' });
      if (mode !== 'auto' && mode !== 'ssh' && mode !== 'relay')
        throw Object.assign(new Error('Pick auto, ssh or relay.'), { code: 'bad_mode' });
      if (!relay) throw Object.assign(new Error('This app has no relay path.'), { code: 'bad_mode' });
      relay.setMode(record.address, mode);
    },
    /** The machine is removed: its relay credential goes, and its Host is told while it is connected. @param {any} record @param {any} [host] */
    forget(record, host) {
      if (!relay?.enrolled(record.address)) return;
      relay
        .forget(record.address, host?.state() === 'online' ? (m, p) => host.call(m, p) : null)
        .catch((error) => noteIgnored('take a removed machine’s relay path away', error));
    },
    dispose() {
      disposed = true;
      offRows();
      offLane?.();
      relay?.dispose();
    },
  };
}

module.exports = { createMachineRelay, ENROLL_RETRY_MS };

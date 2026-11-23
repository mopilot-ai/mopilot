// The services other lanes plug into MoMo's home (scheduler, connectors, notes…) and what each offers: one entry each, by id, run through the home's lifecycle (start, pause, wipe) and asked to seed what they keep before a move is checked.

/**
 * `start` runs when this Host becomes (or is again) the running home, `pause` when it stops acting (a move begins, Reset), `wipe` when its data is about to be
 * deleted (a move's end, Reset). `seed` writes one non-empty record of everything the service keeps, through its normal path (the travel test calls it before a
 * move, so a file a service makes lazily is still checked). Hooks must be safe to run again; a hook that throws is reported and the others still run.
 * @typedef {{ start?: () => unknown, pause?: () => unknown, wipe?: () => unknown, seed?: () => unknown }} ServiceHooks
 */

/**
 * @param {object} o
 * @param {(message: string) => void} o.report
 * @param {() => boolean} o.running whether this Host is the running home now (a service registered then starts at once)
 */
export function createServiceRegistry({ report, running }) {
  /** @type {Map<string, ServiceHooks>} */
  const services = new Map();
  /** What each service offers to its wire methods. @type {Map<string, unknown>} */
  const apis = new Map();
  /** One service's hook; a failure is reported, never thrown. @param {string} id @param {ServiceHooks} hooks @param {'start' | 'pause' | 'wipe' | 'seed'} event */
  const run = async (id, hooks, event) => {
    try {
      await hooks[event]?.();
    } catch (error) {
      report(`MoMo service ${id} failed on ${event}: ${/** @type {Error} */ (error).message}`);
    }
  };
  return {
    /** Plug a service into the home's lifecycle; the same id again replaces it. @param {string} id @param {ServiceHooks} hooks */
    use(id, hooks) {
      services.set(id, hooks);
      // registered into a home that is already running here (a Host that booted as one): it starts at once, so no lane depends on boot order
      if (running()) void run(id, hooks, 'start');
    },
    /** A service offers an API to its own wire methods (they read it with `service`). @param {string} id @param {unknown} api */
    provide(id, api) {
      apis.set(id, api);
    },
    /** What a service offered, or undefined. @param {string} id */
    service: (id) => apis.get(id),
    /** The services plugged in and whether each can seed its files (the travel test fails for one that cannot). */
    serviceList: () => [...services].map(([id, hooks]) => ({ id, seeds: typeof hooks.seed === 'function' })),
    /** Every service writes one non-empty record of what it keeps. */
    async seed() {
      for (const [id, hooks] of services) await run(id, hooks, 'seed');
    },
    /** Tell the services the home started, paused or is about to wipe its data. @param {'start' | 'pause' | 'wipe'} event */
    async lifecycle(event) {
      for (const [id, hooks] of services) await run(id, hooks, event);
    },
  };
}

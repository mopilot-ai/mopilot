// One tab's CDP screencast shared by its recorders (#3752): the turn trace, browser_record and the GIF recorder each hold a lease, the screencast starts with the first and stops with the last, so one stopping never ends another's frames.
const { noteIgnored } = require('../../ignored.cjs');

/** @type {WeakMap<object, { owners: Set<object>, started: boolean, gen: number }>} tab -> who holds its screencast and whether CDP is casting */
const leases = new WeakMap();

/** `owner` holds `tab`'s screencast; it is started when CDP is not casting it (first lease, or after the debugger detached). */
function acquire(
  /** @type {any} */ tab,
  /** @type {object} */ owner,
  /** @type {object} */ params,
  /** @type {(() => void) | undefined} */ onFail = undefined,
) {
  let lease = leases.get(tab);
  if (!lease) leases.set(tab, (lease = { owners: new Set(), started: false, gen: 0 }));
  lease.owners.add(owner);
  if (lease.started) return;
  const l = lease;
  l.started = true;
  const gen = ++l.gen;
  tab.send('Page.startScreencast', params).catch((/** @type {unknown} */ error) => {
    // a start that failed after a newer one began (a detach in between) says nothing about the newer one
    if (l.gen === gen) {
      l.started = false;
      onFail?.();
    }
    noteIgnored('start a screencast of a browser tab', error);
  });
}

/** `owner` lets go of `tab`'s screencast; the last one to do so stops it. */
function release(/** @type {any} */ tab, /** @type {object} */ owner) {
  const lease = leases.get(tab);
  if (!lease?.owners.delete(owner) || lease.owners.size) return;
  const was = lease.started;
  lease.started = false;
  if (was)
    tab.send('Page.stopScreencast').catch((/** @type {unknown} */ error) => noteIgnored('stop a screencast of a browser tab', error));
}

/** The tab's debugger detached: CDP no longer casts it, the holders stay and the next acquire starts it again. */
function detached(/** @type {any} */ tab) {
  const lease = leases.get(tab);
  if (lease) lease.started = false;
}

module.exports = { acquire, release, detached };

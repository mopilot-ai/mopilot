// Host's gate: MoMo's gate class (electron/momo/access.cjs) with no invite, so Host's chip, registry, SSH tunnels and heartbeats exist for every signed-in account while the host.enabled kill switch is on. The machines are always the user's own.
const path = require('node:path');
const { MomoAccess } = require('../momo/access.cjs');
const { isEnabled } = require('../platform/flags.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** No invite: Host is open to every signed-in account (it was the `host` invite in the closed alpha). */
const FEATURE = null;
const FLAG = 'host.enabled';

/** @type {InstanceType<typeof MomoAccess> | null} */
let current = null;
/** Main's Host services, told each change of the app's gate. */
const watchers = new Set();

/**
 * Creates the app's gate (at sign-in setup, before any Host service or IPC). The cache file is userData/host-access.json.
 * @param {Omit<ConstructorParameters<typeof MomoAccess>[0], 'feature' | 'flagOn' | 'file'> & { dir: string, flagOn?: () => boolean }} o
 */
function openHostAccess({ dir, flagOn = () => isEnabled(FLAG), ...o }) {
  current?.dispose();
  current = new MomoAccess({ ...o, file: path.join(dir, 'host-access.json'), feature: FEATURE, flagOn });
  current.onChange((allowed) => {
    for (const cb of [...watchers])
      try {
        cb(allowed);
      } catch (error) {
        // one service that can't follow the change keeps no other from it
        noteIgnored('tell a Host service its access changed', error);
      }
  });
  return current;
}

/** Calls `cb` on every change of whether Host may exist (sign-in, sign-out, the kill switch); returns the unsubscribe. */
function onHostAccess(/** @type {(allowed: boolean) => void} */ cb) {
  watchers.add(cb);
  return () => void watchers.delete(cb);
}

/** Whether Host may exist now: false until the gate is open. */
function hostAccess() {
  return current ? current.allowed() : false;
}

/** The account status changed (electron/app/identity.cjs). */
function updateHostAccess(/** @type {Parameters<InstanceType<typeof MomoAccess>['update']>[0]} */ status) {
  current?.update(status);
}

/** The remote switches were loaded or changed (electron/app/flags.cjs). */
function recomputeHostAccess() {
  if (!current) return;
  current.flagsLoaded = true;
  current.recompute();
}

module.exports = { openHostAccess, onHostAccess, hostAccess, updateHostAccess, recomputeHostAccess, FEATURE, FLAG };

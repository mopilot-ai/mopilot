// What the row says of updating a machine's Host from the app: whether its Host is not the build this app carries, and an update under way (uploading, waiting for the Host to be idle, or failed with its cause), kept in memory per machine.
const { userError } = require('../../shared/userError.mjs');
const { compareVersions } = require('../../shared/semver.mjs');
const { compareVersionParts, parseExactVersion } = require('../../shared/exactSemver.mjs');
const { clock } = require('../platform/ports/clock.cjs');

/** How long a Host that took an update may take to restart into it: it waits for every turn to end first. */
const WAIT_MS = 10 * 60 * 1000;
const UPDATE_DEFERRED = 'update_deferred';
const RESTART_UNCONFIRMED = 'update_restart_unconfirmed';

/**
 * @param {{ appBuild: () => string, appVersion?: () => string }} o `appBuild` reads the build id of the Host this app carries ('' when unknown: no machine is then called old); it is asked once, when the first machine has answered.
 * `appVersion` reads the version of this app, the one value that orders a Host against it (a build id is a hash): without it no Host is called newer.
 */
function createUpdateStates({ appBuild, appVersion = () => '' }) {
  /** @type {string | null} */
  let known = null;
  /** @type {string | null} */
  let knownVersion = null;
  /**
   * How a Host of another build stands to this app: a Host that names no build, or none of a version, predates the version this app records, so it is older; with both versions the larger is the newer; the same version of another build (a developer's, or a rebuild) cannot be ordered.
   * @param {string} hostBuild @param {string} hostVersion @returns {'older' | 'newer' | 'differs'}
   */
  const orderOf = (hostBuild, hostVersion) => {
    const mine = (knownVersion ??= appVersion());
    if (!hostBuild) return 'older';
    if (!mine) return 'differs';
    if (!hostVersion) return 'older';
    const order = compareVersions(hostVersion, mine);
    return order < 0 ? 'older' : order > 0 ? 'newer' : 'differs';
  };
  /** @type {Map<string, { state: 'running' | 'waiting' | 'failed', error: string, since: number, needsPair?: boolean, restartUnconfirmed?: boolean }>} */
  const states = new Map();
  const updates = {
    /**
     * The row's update fields for a machine whose Host says it runs `hostBuild` (made by an app of `hostVersion`): none for a Host that is current and not updating. `hostStale` is a Host Update would bring up to date (older, or of an order nobody can tell: `hostDiffers`); `hostNewer` is one Update would downgrade.
     * @param {string} id @param {string} hostBuild @param {boolean} answered whether the Host has answered at all @param {string} [hostVersion]
     * @returns {{ hostStale?: true, hostNewer?: true, hostDiffers?: true, update?: 'running' | 'waiting' | 'failed', updateError?: string, updateNeedsPair?: true }}
     */
    rowFor(id, hostBuild, answered, hostVersion = '') {
      const here = (known ??= appBuild());
      const other = answered && !!here && hostBuild !== here;
      const order = other ? orderOf(hostBuild, hostVersion) : null;
      const stale = order === 'older' || order === 'differs';
      // A current Host also clears a failed restart acknowledgment if the restart took effect.
      const last = states.get(id);
      if (!stale && (last?.state === 'waiting' || (answered && here && last?.restartUnconfirmed))) states.delete(id);
      const now = states.get(id);
      const hostStale = {
        ...(stale && { hostStale: /** @type {const} */ (true) }),
        ...(order === 'differs' && { hostDiffers: /** @type {const} */ (true) }),
        ...(order === 'newer' && { hostNewer: /** @type {const} */ (true) }),
      };
      if (now?.state === 'waiting' && clock.now() - now.since > WAIT_MS)
        return { ...hostStale, update: 'failed', updateError: 'The Host has not restarted. A turn may still be running.' };
      return now
        ? {
            ...hostStale,
            update: now.state,
            updateError: now.error,
            ...(now.needsPair ? { updateNeedsPair: /** @type {const} */ (true) } : {}),
          }
        : hostStale;
    },
    /** Whether a registry record's Host is not behind this app (it then knows key changes); asked by key rotation. @param {{ id: string, hostBuild: string, hostAppVersion: string }} r */
    isCurrent: (r) => !updates.rowFor(r.id, r.hostBuild, true, r.hostAppVersion).hostStale,
    /** Whether the Host's build is strictly older and eligible for an automatic update. @param {{ id: string, hostBuild: string, hostAppVersion: string }} r */
    isOlder(r) {
      if (typeof r.hostBuild !== 'string' || typeof r.hostAppVersion !== 'string') return false;
      const here = (known ??= appBuild());
      const mine = parseExactVersion((knownVersion ??= appVersion()));
      if (!here || r.hostBuild === here || !mine) return false;
      if (r.hostAppVersion === '') return true;
      const reported = parseExactVersion(r.hostAppVersion);
      if (!reported || reported.core.join('.') !== r.hostAppVersion.trim().replace(/^v/, '').split('-', 1)[0]) return false;
      return reported.pre.every((part) => part && !/^0\d+$/.test(part)) && compareVersionParts(reported, mine) < 0;
    },
    /** Whether a registry record's Host is newer than this app (Update would downgrade it); false for no record. @param {{ id: string, hostBuild: string, hostAppVersion: string } | undefined} r */
    isNewer: (r) => !!r && !!updates.rowFor(r.id, r.hostBuild, true, r.hostAppVersion).hostNewer,
    /** A Host newer than this app is not replaced by the app's older build (#4923): a call that comes anyway is refused before it leaves a failure on the row. @param {Parameters<typeof updates.isNewer>[0]} r */
    refuseNewer(r) {
      if (updates.isNewer(r)) throw Object.assign(new Error('Host is newer than this app. Update MoPilot.'), { code: 'host_newer' });
    },
    /**
     * Runs one update and keeps its state for the row; a second request while one runs is refused.
     * @template T
     * @param {string} id @param {(ownsUpdate: () => boolean) => Promise<T>} update @param {() => void} changed
     * @returns {Promise<T>}
     */
    async run(id, update, changed) {
      const previous = states.get(id);
      if (previous?.state === 'running') throw Object.assign(new Error('Already updating this machine.'), { code: 'busy' });
      // a try after a failure keeps the cause of the last one on the row until it ends, so the person can still read why it needs one
      const active = { state: /** @type {const} */ ('running'), error: previous?.error ?? '', since: clock.now() };
      states.set(id, active);
      changed();
      let out;
      try {
        out = await update(() => states.get(id) === active);
      } catch (e) {
        if (states.get(id) === active) {
          if (e?.code === UPDATE_DEFERRED) {
            if (previous) states.set(id, previous);
            else states.delete(id);
          } else {
            states.set(id, {
              state: 'failed',
              error: userError(e),
              since: clock.now(),
              needsPair: e?.code === 'unknown_client' || e?.code === 'not_paired',
              restartUnconfirmed: e?.code === RESTART_UNCONFIRMED,
            });
          }
          changed();
        }
        throw e;
      }
      if (states.get(id) !== active) return out;
      states.set(id, { state: 'waiting', error: '', since: clock.now() });
      changed();
      return out;
    },
    /** @param {string} id */
    forget: (id) => void states.delete(id),
  };
  /** What key rotation and the updater ask of these states. */
  return { ...updates, forUpdater: { isCurrent: updates.isCurrent, isOlder: updates.isOlder, isNewer: updates.isNewer } };
}

module.exports = { createUpdateStates, WAIT_MS, UPDATE_DEFERRED, RESTART_UNCONFIRMED };

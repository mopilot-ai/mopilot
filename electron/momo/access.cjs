// MoMo's closed-alpha gate (#2139): MoMo exists only for a signed-in MoPilot account the server invited (`features` on /api/me) while the momo.enabled kill switch is on; the last answer is kept per account for a week offline.
const { fs } = require('../platform/ports/fs.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isEnabled } = require('../platform/flags.cjs');

const FEATURE = 'momo';
const FLAG = 'momo.enabled';
/** How long an invite read from the server still counts without reaching the server again. */
const MAX_OFFLINE_MS = 7 * 24 * 3600_000;
/** While MoMo is allowed, the account is read again this often, so a revoke takes effect with no window open. */
const REFRESH_MS = 30 * 60_000;

/**
 * @typedef {{ userId: string, allowed: boolean, at: number }} AccessCache the last answer the server gave for one account
 * @typedef {{ signedIn?: boolean, user?: { id?: string, features?: unknown } | null, checkedAt?: number | null }} AccountStatus
 *   the MoPilot account's status (electron/identity/mopilot.cjs status()); checkedAt is set once /api/me answered in this run
 */

/** The account's features from a status read in this run, or null when this run has no answer from the server yet. */
function freshFeatures(/** @type {AccountStatus | null} */ status) {
  const features = status?.user?.features;
  if (typeof status?.checkedAt !== 'number' || !Array.isArray(features)) return null;
  return features.filter((f) => typeof f === 'string');
}

/**
 * Whether MoMo may exist now. Signed out, another account, no answer within a week, or the switch off: no.
 * devInvite stands in for the server's invite in an unpackaged build (MOPILOT_MOMO_DEV=1), for development only.
 * @param {{ status: AccountStatus | null, cache: AccessCache | null, flagOn: boolean, now: number, devInvite?: boolean, feature?: string | null }} o
 * `feature` is the invite that opens it: MoMo's by default; null for a feature open to every signed-in account (Host and Mobile
 * Remote, which reuse this gate), which then needs only the kill switch and a signed-in account.
 */
function decide({ status, cache, flagOn, now, devInvite = false, feature = FEATURE }) {
  if (!flagOn) return false;
  if (devInvite) return true;
  const userId = status?.signedIn ? status.user?.id : null;
  if (typeof userId !== 'string' || !userId) return false;
  if (feature === null) return true;
  const features = freshFeatures(status);
  if (features) return features.includes(feature);
  return !!cache && cache.userId === userId && cache.allowed === true && cache.at <= now && now - cache.at < MAX_OFFLINE_MS;
}

/** A cache file's contents, or null when it is missing or not one. @returns {AccessCache | null} */
function readCache(/** @type {string} */ file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c.userId === 'string' && typeof c.allowed === 'boolean' && typeof c.at === 'number') return c;
  } catch (error) {
    noteIgnored('read the MoMo access cache', error, ['ENOENT']);
  }
  return null;
}

class MomoAccess {
  /**
   * @param {object} o
   * @param {string} o.file userData/momo-access.json
   * @param {() => unknown} o.refresh reads the account again (MoPilotAccount.refreshStatus)
   * @param {(allowed: boolean) => void} [o.broadcast] tells the windows when the answer changes
   * @param {() => boolean} [o.flagOn] the kill switch
   * @param {boolean} [o.devInvite] an unpackaged build's stand-in for the server's invite (decide())
   * @param {string | null} [o.feature] the invite this gate follows (default: MoMo's; null: none, every signed-in account)
   * @param {boolean} [o.waitForFlags] stays closed until the remote switches are loaded (the first recomputeMomoAccess)
   * @param {() => number} [o.now]
   * @param {{ set: typeof setInterval, clear: typeof clearInterval }} [o.timers]
   */
  constructor(o) {
    this.o = {
      broadcast: () => {
        /* no windows to tell */
      },
      flagOn: () => isEnabled(FLAG),
      devInvite: false,
      feature: FEATURE,
      waitForFlags: false,
      now: Date.now,
      timers: { set: setInterval, clear: clearInterval },
      ...o,
    };
    /** @type {AccountStatus | null} */
    this.status = null;
    this.cache = readCache(this.o.file);
    this.current = false;
    /** whether the kill switch can be read yet: main loads the cached switches after the account (electron/app/startup.cjs) */
    this.flagsLoaded = !this.o.waitForFlags;
    /** @type {Set<(allowed: boolean) => void>} */
    this.listeners = new Set();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  allowed() {
    return this.current;
  }

  /** @param {(allowed: boolean) => void} cb @returns {() => void} */
  onChange(cb) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** A new account status: keeps the server's answer for this account, forgets it on sign-out. */
  update(/** @type {AccountStatus | null} */ status) {
    this.status = status;
    if (!status?.signedIn && this.cache) this.#writeCache(null);
    const features = freshFeatures(status);
    const userId = status?.user?.id;
    if (features && typeof userId === 'string' && typeof status?.checkedAt === 'number') {
      const next = { userId, allowed: this.o.feature === null || features.includes(this.o.feature), at: status.checkedAt };
      const same = this.cache && this.cache.userId === next.userId && this.cache.allowed === next.allowed && this.cache.at === next.at;
      if (!same) this.#writeCache(next);
    }
    this.recompute();
  }

  /** Decides again (after a status, or when the kill switch changes) and tells the listeners on a change. */
  recompute() {
    const flagOn = this.flagsLoaded && this.o.flagOn();
    const next = decide({
      status: this.status,
      cache: this.cache,
      flagOn,
      now: this.o.now(),
      devInvite: this.o.devInvite,
      feature: this.o.feature,
    });
    this.#timer(next);
    if (next === this.current) return;
    this.current = next;
    this.o.broadcast(next);
    for (const cb of this.listeners) cb(next);
  }

  dispose() {
    this.#timer(false);
    this.listeners.clear();
  }

  #timer(/** @type {boolean} */ on) {
    if (on && !this.timer) {
      this.timer = this.o.timers.set(() => {
        Promise.resolve()
          .then(() => this.o.refresh())
          .catch((error) => noteIgnored('read the MoPilot account for MoMo', error));
      }, REFRESH_MS);
      this.timer?.unref?.();
    } else if (!on && this.timer) {
      this.o.timers.clear(this.timer);
      this.timer = null;
    }
  }

  #writeCache(/** @type {AccessCache | null} */ next) {
    this.cache = next;
    try {
      if (next) writePrivate(this.o.file, JSON.stringify(next));
      else fs.rmSync(this.o.file, { force: true });
    } catch (error) {
      // the answer still holds for this run; only the offline copy is missing
      noteIgnored('save the MoMo access cache', error);
    }
  }
}

// The app's one gate, so any main-process module can ask momoAllowed().
/** @type {MomoAccess | null} */
let current = null;
/** Main's MoMo services, told each change of the app's gate (whichever gate is open then). */
const watchers = new Set();

/** Creates the app's gate (at sign-in setup, before any MoMo service or IPC). @param {ConstructorParameters<typeof MomoAccess>[0]} o */
function openMomoAccess(o) {
  current?.dispose();
  current = new MomoAccess(o);
  current.onChange((allowed) => {
    for (const cb of [...watchers])
      try {
        cb(allowed);
      } catch (error) {
        // one service that can't follow the change keeps no other from it
        noteIgnored('tell a MoMo service its access changed', error);
      }
  });
  return current;
}

/** Calls `cb` on every change of whether MoMo may exist (a revoke, the invite, sign-out); returns the unsubscribe. */
function onMomoAccess(/** @type {(allowed: boolean) => void} */ cb) {
  watchers.add(cb);
  return () => void watchers.delete(cb);
}

/** Whether MoMo may exist now: false until the gate is open. */
function momoAllowed() {
  return current ? current.allowed() : false;
}

/** Told when anything the gate follows may have changed: the account (it may be another one) or the remote switches (a flag that loaded late). */
const stateWatchers = new Set();
function onMomoState(/** @type {() => void} */ cb) {
  stateWatchers.add(cb);
  return () => void stateWatchers.delete(cb);
}
const tellState = () => {
  for (const cb of [...stateWatchers])
    try {
      cb();
    } catch (error) {
      noteIgnored('tell a MoMo service its account or switches changed', error);
    }
};

/**
 * The id of the account the server said, in this run, may NOT see MoMo: a revoke in so many words. Not the kill switch, not a Mac that is offline, signed out or
 * has not heard from the server yet, and not a flag that has not loaded: those are "unknown", and a phone must not read them as no. Null for all of them.
 * @returns {string | null}
 */
function momoRevokedFor() {
  if (!current) return null;
  const { status, o } = current;
  const id = status?.signedIn ? status.user?.id : null;
  const features = freshFeatures(status);
  // a gate open to every signed-in account (no invite) and the dev stand-in for the invite have no revoke to tell
  if (features === null || typeof id !== 'string' || !id || !o.feature || o.devInvite) return null;
  return features.includes(o.feature) ? null : id;
}

/** The id of the signed-in MoPilot account the gate last heard of, null when none: what MoMo's data on this Mac belongs to. */
function momoUserId() {
  const id = current?.status?.signedIn ? current.status.user?.id : null;
  return typeof id === 'string' && id ? id : null;
}

/** The account status changed (electron/app/identity.cjs). */
function updateMomoAccess(/** @type {AccountStatus | null} */ status) {
  current?.update(status);
  tellState();
}

/** The remote switches were loaded or changed (electron/app/flags.cjs). */
function recomputeMomoAccess() {
  if (!current) return;
  current.flagsLoaded = true;
  current.recompute();
  tellState();
}

module.exports = {
  MomoAccess,
  decide,
  openMomoAccess,
  onMomoAccess,
  onMomoState,
  momoUserId,
  momoAllowed,
  momoRevokedFor,
  updateMomoAccess,
  recomputeMomoAccess,
  FEATURE,
  FLAG,
  MAX_OFFLINE_MS,
  REFRESH_MS,
};

// Mobile Remote's gate: MoMo's gate class (electron/momo/access.cjs) with no invite, so the Mobile Remote settings, the relay runtime and the menu-bar agent exist for every signed-in account while the remote.enabled kill switch is on (the user's own opt-in in Settings, electron/remote/consent.cjs, comes on top).
const path = require('node:path');
const { MomoAccess, MAX_OFFLINE_MS } = require('../momo/access.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const { isEnabled } = require('../platform/flags.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** No invite: Mobile Remote is open to every signed-in account (it was the `phone` invite in the closed alpha). */
const FEATURE = null;
const FLAG = 'remote.enabled';

/** @type {InstanceType<typeof MomoAccess> | null} */
let current = null;
/** Main's phone services, told each change of the app's gate. */
const watchers = new Set();

/**
 * Creates the app's gate (at sign-in setup, before the remote runtime). The cache file is userData/phone-access.json.
 * @param {Omit<ConstructorParameters<typeof MomoAccess>[0], 'feature' | 'flagOn' | 'file'> & { dir: string, flagOn?: () => boolean }} o
 */
function openPhoneAccess({ dir, flagOn = () => isEnabled(FLAG), ...o }) {
  current?.dispose();
  current = new MomoAccess({ ...o, file: path.join(dir, 'phone-access.json'), feature: FEATURE, flagOn });
  current.onChange((allowed) => {
    for (const cb of [...watchers])
      try {
        cb(allowed);
      } catch (error) {
        // one service that can't follow the change keeps no other from it
        noteIgnored('tell a Mobile Remote service its access changed', error);
      }
  });
  return current;
}

/** Calls `cb` on every change of whether Mobile Remote may exist (sign-in, sign-out, the kill switch); returns the unsubscribe. */
function onPhoneAccess(/** @type {(allowed: boolean) => void} */ cb) {
  watchers.add(cb);
  return () => void watchers.delete(cb);
}

/** Whether Mobile Remote may exist now: false until the gate is open. */
function phoneAccess() {
  return current ? current.allowed() : false;
}

/** The account status changed (electron/app/identity.cjs). */
function updatePhoneAccess(/** @type {Parameters<InstanceType<typeof MomoAccess>['update']>[0]} */ status) {
  current?.update(status);
}

/** The remote switches were loaded or changed (electron/app/flags.cjs). */
function recomputePhoneAccess() {
  if (!current) return;
  current.flagsLoaded = true;
  current.recompute();
}

/**
 * Whether the last answer the server gave for the signed-in account still holds, read before the account has been (the login-item start decides on
 * this, ahead of the window; a wrong "yes" only opens the window later). False with the switch off, no cache or an old one (the cache goes at sign-out, so one within the week means this Mac was signed in).
 * @param {string} dir userData
 * @param {() => number} [now]
 */
function phoneAccessAtStart(dir, now = Date.now) {
  if (!isEnabled(FLAG)) return false;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'phone-access.json'), 'utf8'));
    // any account's answer: there is no invite, and the file goes at sign-out, so one there (even an alpha-era "no") means signed in
    return typeof c?.userId === 'string' && typeof c.at === 'number' && c.at <= now() && now() - c.at < MAX_OFFLINE_MS;
  } catch {
    // no cache (never signed in here, signed out) or an unreadable one: not yet
    return false;
  }
}

module.exports = {
  phoneAccessAtStart,
  openPhoneAccess,
  onPhoneAccess,
  phoneAccess,
  updatePhoneAccess,
  recomputePhoneAccess,
  FEATURE,
  FLAG,
};

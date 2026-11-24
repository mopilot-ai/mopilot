// The guard of MoMo's wire methods (home lane): a Host that is not MoMo's running home acts for it in nothing. Every `host.momo*` handler runs only while this Host is the running home (a live grant and a home at its record that is running), and otherwise refuses with its cause: `momo_grant_lapsed` when the grant has run out, `momo_home_away` for a Host MoMo moved away from, one that is moving, retired or never made one. The few that must answer anywhere are named below; reads refuse too, because an empty answer reads on a client as "no notes" or "no cards", which looks like deletion. A file of host/src/methods hands the collector this as its `guard`; tests/hostMomoNotHome.invariant.test.ts calls every other handler against a home that is not running.
import { HostRefusal } from './hostFs.mjs';

/** The methods that answer on a Host that is not the home, each with why: the grant and the status say what is here, a start makes a home, a move is how it goes elsewhere, a reset deletes what this machine holds, a look says what it holds and a stand-down retires an older home. */
export const OFF_HOME_OK = Object.freeze([
  'host.momoGrant',
  'host.momoStatus',
  'host.momoHomeStart',
  'host.momoMove',
  'host.momoReset',
  'host.momoHomeLook',
  'host.momoStandDown',
]);

/** @param {{ granted: () => boolean, stamp: () => unknown, machine: () => string, entitlement?: { lapse: () => { code: string, message: string } | null } | null }} home */
export function requireHome(home) {
  if (!home.granted()) {
    // a grant held back by its entitlement says that (withdrawn, run out, not invited), not that the grant ran out
    const why = home.entitlement?.lapse();
    throw why
      ? new HostRefusal(why.code, why.message)
      : new HostRefusal('momo_grant_lapsed', `MoMo's grant has run out on ${home.machine()}.`);
  }
  if (!home.stamp()) throw new HostRefusal('momo_home_away', `MoMo's home is not running on ${home.machine()}.`);
}

/** The collector's `guard` for a file: wraps each handler of a method that must run at the home. A Host with no MoMo at all (no `momo` given) serves none: every handler refuses, whatever the veil said. @param {{ granted: () => boolean, stamp: () => unknown, machine: () => string } | undefined} home */
export const onlyAtHome = (home) => (/** @type {string} */ method, /** @type {(...args: any[]) => unknown} */ run) => {
  if (!home)
    return () => {
      throw new HostRefusal('momo_home_away', 'MoMo is not set up on this machine.');
    };
  if (OFF_HOME_OK.includes(method)) return run;
  return (/** @type {any[]} */ ...args) => {
    requireHome(home);
    return run(...args);
  };
};

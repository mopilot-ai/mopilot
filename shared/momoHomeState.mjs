// What a client says of MoMo's home (design 1, "Always there"): the five states, derived in one place from what the Host kept and what the client can see of the machine, so the Mac, the phone and the Settings row never disagree. Pure; the screens come later.

/** A heartbeat older than this means the machine is not answering (the pill turns amber, "asleep"). */
export const ASLEEP_AFTER_MS = 2 * 60_000;

/** @typedef {'running' | 'moving' | 'asleep' | 'needs-update' | 'needs-sign-in'} HomeState */

/**
 * @param {object} o
 * @param {'none' | 'running' | 'moving'} o.kept the state the home record holds on the Host
 * @param {number | null} o.heardAt when the client last heard from that Host (a status or a heartbeat), null when never this session
 * @param {number} o.now
 * @param {boolean} o.reachable whether the link to the machine is up right now
 * @param {boolean} o.current whether the Host's build speaks the `momo` feature at this protocol
 * @param {boolean} o.signedIn whether at least one agent MoMo may think with is signed in on the Host
 * @returns {HomeState | null} null while there is no home
 */
export function homeStateOf({ kept, heardAt, now, reachable, current, signedIn }) {
  if (kept === 'none') return null;
  if (!current) return 'needs-update';
  if (!reachable || heardAt === null || now - heardAt > ASLEEP_AFTER_MS) return 'asleep';
  if (kept === 'moving') return 'moving';
  return signedIn ? 'running' : 'needs-sign-in';
}

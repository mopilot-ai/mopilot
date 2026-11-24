// The Host's decision on a MoMo grant (#5474): whether an account's `host.momoGrant` is backed by a server-signed entitlement made for this Host, newer than the last one taken, and still good (with a clock-only grace). Pure over an opaque `state` the caller keeps sealed next to its grant, so replay, revocation and downgrade survive a restart.
import {
  ENTITLEMENT_FAILURES,
  ENTITLEMENT_GRACE_MS,
  ENTITLEMENT_REQUIRED_GRACE_MS,
  ENTITLEMENT_MAX_VALIDITY_MS,
  ENTITLEMENT_SKEW_MS,
  verifyEntitlement,
} from '../../shared/host/momoEntitlement.mjs';

export const MOMO_ENTITLEMENT_MODES = ['off', 'warn', 'required'];

/**
 * What the Host keeps: the newest `iat` taken (the floor), when it first took a signed token (`signedSince`: from then on an unsigned grant is a downgrade), and that token's account, features and `exp`.
 * @typedef {{ floorIat: number, signedSince: number | null, account: string | null, features: string[], exp: number, clockMark: number, held: boolean }} EntitlementState
 * @typedef {{ ok: true, state: EntitlementState, features: string[], signed: boolean, warning: string | null, pausesAt: number | null } | { ok: false, state: EntitlementState, code: keyof typeof ENTITLEMENT_FAILURES, message: string }} Decision
 */

/** @returns {EntitlementState} */
export const emptyEntitlementState = () => ({
  floorIat: 0,
  signedSince: null,
  account: null,
  features: [],
  exp: 0,
  clockMark: 0,
  held: false,
});

/** @param {any} v @returns {EntitlementState} the state as kept, made safe to use whatever the file held */
export const entitlementStateShape = (v) => ({
  floorIat: Number.isSafeInteger(v?.floorIat) ? v.floorIat : 0,
  signedSince: Number.isSafeInteger(v?.signedSince) ? v.signedSince : null,
  account: typeof v?.account === 'string' ? v.account : null,
  features: Array.isArray(v?.features) ? v.features.filter((/** @type {unknown} */ f) => typeof f === 'string') : [],
  exp: Number.isSafeInteger(v?.exp) ? v.exp : 0,
  clockMark: Number.isSafeInteger(v?.clockMark) ? v.clockMark : 0,
  held: v?.held === true,
});

/** The mode a Host runs in from its environment; anything but `warn` and `required` is the alpha's `off`. @param {Record<string, string | undefined>} env */
export const entitlementModeFrom = (env) => {
  const v = env.MOPILOT_MOMO_ENTITLEMENT;
  return v === 'warn' || v === 'required' ? v : 'off';
};

/**
 * @param {object} o
 * @param {string} o.hostId the pairing id the entitlement must be made for
 * @param {import('../../shared/host/momoEntitlement.mjs').TrustedKey[]} o.keys
 * @param {string[]} [o.revoked] key ids that no longer count
 * @param {'off' | 'warn' | 'required'} [o.mode]
 * @param {() => number} o.now
 */
export function createEntitlementGate({ hostId, keys, revoked = [], mode = 'off', now }) {
  // required with no key to check against locks every account out, and says so (entitlement_unknown_key: the update is the fix); it never stops the Host
  /** How long past `exp` a token still holds: short where entitlements are required. */
  const graceMs = mode === 'required' ? ENTITLEMENT_REQUIRED_GRACE_MS : ENTITLEMENT_GRACE_MS;
  /** The time the gate acts on: never behind what it has seen before (a clock set back stretches nothing) or the newest token it took. @param {EntitlementState} state */
  const clockOf = (state) => Math.max(now(), state.clockMark, state.floorIat);
  /** @param {EntitlementState} state @param {keyof typeof ENTITLEMENT_FAILURES} code @returns {Decision} */
  const refuse = (state, code) => ({ ok: false, state, code, message: ENTITLEMENT_FAILURES[code] });
  return {
    mode,
    graceMs,
    clockOf,
    /**
     * @param {{ account: string, features: string[], entitlement?: unknown }} grant what the client sent
     * @param {EntitlementState} state
     * @returns {Decision}
     */
    accept({ account, features, entitlement }, state) {
      const at = clockOf(state);
      /** an assertion with nothing to check it by: allowed only while no signed token was ever taken and entitlements are not required @param {string} why */
      const unsigned = (why) => {
        if (mode === 'required' || state.signedSince !== null) return null;
        return /** @type {Decision} */ ({
          ok: true,
          state,
          features,
          signed: false,
          warning: mode === 'warn' ? why : null,
          pausesAt: null,
        });
      };
      if (entitlement === undefined || entitlement === null)
        return unsigned(ENTITLEMENT_FAILURES.entitlement_missing) ?? refuse(state, 'entitlement_missing');
      const v = verifyEntitlement(entitlement, { keys, revoked });
      // a key this Host has not been given yet (a rotation it has not taken): the fix is the update; before any signed token, off and warn go on as the alpha did
      if (!v.ok)
        return (v.code === 'entitlement_unknown_key' && unsigned(ENTITLEMENT_FAILURES.entitlement_unknown_key)) || refuse(state, v.code);
      const c = v.claims;
      if (c.aud !== hostId) return refuse(state, 'entitlement_wrong_host');
      if (c.sub !== account || c.exp - c.iat > ENTITLEMENT_MAX_VALIDITY_MS) return refuse(state, 'entitlement_invalid');
      if (c.iat > at + ENTITLEMENT_SKEW_MS) return refuse(state, 'clock_skew');
      if (c.iat < state.floorIat) return refuse(state, 'entitlement_stale');
      const held = state.held || c.features.includes('momo');
      // what a signed token says is kept whether or not it is taken (a withdrawn one is the floor a held older token cannot undo); the time mark moves only when it is taken, so a refusal can never carry a wrong clock forward
      const seen = {
        floorIat: c.iat,
        signedSince: state.signedSince ?? at,
        account: c.sub,
        features: c.features,
        exp: c.exp,
        clockMark: state.clockMark,
        held,
      };
      if (!c.features.includes('momo')) return refuse(seen, state.held ? 'entitlement_revoked' : 'not_invited');
      // a token newer than any taken that is already out of date by this clock: the clock is ahead, not the token old
      if (at > c.exp + graceMs) return refuse(seen, c.iat > state.floorIat ? 'clock_skew' : 'entitlement_expired');
      return { ok: true, state: { ...seen, clockMark: at }, features: c.features, signed: true, warning: null, pausesAt: c.exp + graceMs };
    },
    /**
     * Whether a grant still holds now (asked before every use, so one that ran out pauses MoMo even when the client stays away). Where entitlements are required a Host that never took a signed token holds none: an alpha grant pauses until its client sends one.
     * @param {EntitlementState} state
     * @returns {{ live: true } | { live: false, code: keyof typeof ENTITLEMENT_FAILURES, message: string }}
     */
    standing(state) {
      /** @param {keyof typeof ENTITLEMENT_FAILURES} code */
      const no = (code) => ({ live: /** @type {const} */ (false), code, message: ENTITLEMENT_FAILURES[code] });
      if (state.signedSince === null) return mode === 'required' ? no('entitlement_missing') : { live: true };
      if (!state.features.includes('momo'))
        return no(state.held ? 'entitlement_revoked' : state.account ? 'not_invited' : 'entitlement_missing');
      return clockOf(state) > state.exp + graceMs ? no('entitlement_expired') : { live: true };
    },
  };
}

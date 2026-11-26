// How the app asks a Host about MoMo's home and runs the steps of the shared rules (shared/momoHomeReal.mjs): `host.momoHomeLook` answers to an owner device without a live grant, so a lapsed grant is "send the grant and look again", never a veil that reads as "no home"; the lease and stand-down steps `decide` returns run once each, in order.

import { execute } from './host/momoHomeClient.mjs';

/** A refusal that only means the Host does not know the request or lacks the feature it needs (an older Host, or a lapsed grant). @param {unknown} error */
export const unknownRequest = (error) =>
  /unknown request/i.test(String(/** @type {any} */ (error)?.message ?? '')) ||
  ['unknown_request', 'feature_missing'].includes(/** @type {any} */ (error)?.code);

/** The codes a refusal of the tunnel or the wait carries: the Host may or may not have taken the call. */
export const TRANSPORT = new Set(['host_unreachable', 'timeout', 'connection_closed', 'closed']);

/**
 * One machine's `host.momoHomeLook` (the owner device asks it without a live grant): a lapsed grant is sent again, never a veil that reads as "no home". A Host
 * that does not know the look throws its refusal, which the caller reads as a build without the feature; any other failure is "not heard".
 * @param {object} o
 * @param {(id: string, method: string, params: object) => Promise<any>} o.call one call within its time
 * @param {(id: string) => Promise<unknown>} [o.grant] tells that Host this account may see MoMo (`host.momoGrant`)
 * @returns {(id: string) => Promise<any>}
 */
export function createAsk({ call, grant }) {
  return async (id) => {
    const look = await call(id, 'host.momoHomeLook', {});
    if (look?.grantLive === false) await grant?.(id)?.catch(() => undefined);
    return look;
  };
}

/** How long a step a Host did not know waits before it is tried again. */
const UNKNOWN_RETRY_MS = 60_000;

/** What the owner is told when a Host refuses a step of the shared rules, by the Host's code. */
const STEP_WORDS = Object.freeze({
  floor_too_high: 'A machine refused MoMo’s new lease as too far ahead. Check again.',
  floor_invalid: 'A machine refused MoMo’s new lease. Check again.',
  epoch_limit: 'MoMo has reached the most leases a home can take, so it can’t move its home again.',
  epoch_unproven: 'A machine would not retire its old copy of MoMo without proof. Check again.',
  climb_failed: 'MoMo’s new lease could not be brought above the older one. Check again.',
});

/** What a step list says when the home was stopped before the step: nothing was refused, and it is not told as done. */
const STOPPED = 'stopped';

/**
 * Runs steps of the shared rules (`decide().steps`, `reviveSteps`, `createSteps`) through its `execute`: a start is repeated up the ladder, and a stand-down is
 * told the lease the start ACTUALLY returned (nobody is stood down when the start failed). The same steps are run once each; a Host too old to know one is left
 * as it is, a dropped tunnel is tried again with the next look, and a refusal comes back in the owner's words.
 * @param {object} o
 * @param {(id: string, method: string, params: object) => Promise<any>} o.call
 * @param {Set<string>} o.told the step lists already done or refused
 * @param {(error: unknown) => void} o.report
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.alive] false once the home was stopped: nothing is begun, and the list is not counted as done; but once a call of the list was sent, the rest goes (every rung of a start's climb and the stand-down that follows), or two homes would stay live
 * @returns {(steps: import('./host/momoHomeClient.mjs').Step[], again?: boolean) => Promise<{ ran: boolean, failure: string | null }>}
 */
export function createSteps({ call, told, report, now = Date.now, alive = () => true }) {
  /** When a step list that a Host did not know is tried again. @type {Map<string, number>} */
  const retryAt = new Map();
  return async (steps, again = false) => {
    const key = JSON.stringify(steps);
    if (!again && (told.has(key) || (retryAt.get(key) ?? 0) > now())) return { ran: false, failure: null };
    told.add(key);
    /** @type {unknown} */
    let refusal = null;
    /** A call of this list was sent: the rest of it goes, whatever happens to the home meanwhile. */
    let started = false;
    /** The home was stopped before a group began: what was not sent is left for the next home. */
    let stopped = false;
    const done = await execute(steps, async (step) => {
      // a stopped home begins nothing; one that already began finishes (the climb's next rung, the stand-down), or two homes would stay live
      if (!started && !alive()) {
        stopped = true;
        return { ok: false, code: STOPPED };
      }
      started = true;
      const { climbTo, own, ...params } = /** @type {any} */ (step.params);
      try {
        const r = await call(step.host, step.call, params);
        // a start answers with the home it holds now: the lease it ACTUALLY got
        return step.call === 'host.momoHomeStart'
          ? { ok: true, leaseEpoch: r?.home?.leaseEpoch, homeId: r?.home?.homeId }
          : { ok: true, leaseEpoch: r?.leaseEpoch ?? params.leaseEpoch };
      } catch (error) {
        refusal = error;
        return { ok: false, code: String(/** @type {any} */ (error)?.code ?? 'failed') };
      }
    });
    const code = done.ok ? /** @type {any} */ (refusal)?.code : done.code;
    if (stopped) {
      told.delete(key);
      return { ran: false, failure: null };
    }
    if (!refusal && done.ok) return { ran: steps.length > 0, failure: null };
    if (TRANSPORT.has(code)) {
      told.delete(key);
      return { ran: false, failure: null };
    }
    if (unknownRequest(refusal)) {
      // a Host that does not know the step, or whose permission for MoMo lapsed (its answer is the same): said, and tried again a little later
      told.delete(key);
      retryAt.set(key, now() + UNKNOWN_RETRY_MS);
      return {
        ran: false,
        failure: 'A machine did not take the next step for MoMo (its app may be older, or its permission lapsed). It is tried again soon.',
      };
    }
    report(refusal ?? new Error(String(code)));
    return {
      ran: false,
      failure:
        /** @type {Record<string, string>} */ (STEP_WORDS)[code] ??
        (String(/** @type {any} */ (refusal)?.message ?? '') || 'MoMo couldn’t settle which machine is its home. Check again.'),
    };
  };
}

/**
 * A machine and its Host's two move calls, for the move runner.
 * @param {{ machines: () => import('./momoHomeView.mjs').MachineRecord[], call: (id: string, method: string, params: object, ms: number) => Promise<any>, callMs: number }} o
 */
export function machineSides({ machines, call, callMs }) {
  return (/** @type {string} */ id) => {
    const m = machines().find((x) => x.id === id);
    if (!m) return null;
    return {
      id: m.id,
      hostId: m.hostId,
      name: m.name,
      side: {
        call: (/** @type {string} */ op, /** @type {object} */ params = {}) => call(id, 'host.momoMove', { op, ...params }, callMs),
      },
    };
  };
}

// The rules that keep at most one live home of MoMo, as pure functions (home lane): which epoch a new home starts at, what a Host answers when asked what it holds, and which of two homes stands down. The Host runs them inside its own writes (host/src/momoHomeSafety.mjs), the Mac and the phone run the client's side of them (./momoHomeClient.mjs), and the model test (tests/momoHomeSafetyModel.test.ts) runs both over every order of events.

/** @typedef {{ homeId: string | null, leaseEpoch: number, state: 'none' | 'running' | 'moving', name: string, movedTo: { name: string, homeId: string, at: number } | null, retired?: { at: number, lastActive: number } | null, lastSeenAt?: number }} Record */

/** The largest lease epoch there is: a start at the limit is refused with a typed answer, never clamped or wrapped. */
export const EPOCH_MAX = 1_000_000_000;
/** How far above the highest epoch a Host knows a caller's floor or a stand-down's epoch may be: a client that saw more than this has seen a Host this one has never heard of, and says so by looking again. */
export const FLOOR_STEP = 64;

/** Whether lease `a` beats lease `b`: the higher epoch, and at the same epoch the greater home id, so two homes that met at one epoch have one winner every client and Host agrees on. @param {{ leaseEpoch: number, homeId: string | null }} a @param {{ leaseEpoch: number, homeId: string | null }} b */
export const leaseWins = (a, b) => a.leaseEpoch > b.leaseEpoch || (a.leaseEpoch === b.leaseEpoch && String(a.homeId) > String(b.homeId));

/**
 * The epoch a new (or re-leased) home starts at: above this Host's own highest, above the newest stamp it has seen, and above the floor the caller names (the highest it has seen on any Host), so an older home that returns is below it. A floor that is not an epoch, one more than FLOOR_STEP above what this Host knows, and a start past EPOCH_MAX are refused.
 * @param {number} own this Host's epoch now @param {unknown} floor absent: none @param {number} [known] the newest epoch this Host has seen in a stamp
 * @returns {{ ok: true, epoch: number } | { ok: false, code: 'floor_invalid' | 'floor_too_high' | 'epoch_limit' }}
 */
export function startEpoch(own, floor, known = 0) {
  const f = floor === undefined ? 0 : floor;
  if (typeof f !== 'number' || !Number.isSafeInteger(f) || f < 0) return { ok: false, code: 'floor_invalid' };
  const highest = Math.max(own, known);
  if (f > highest + FLOOR_STEP) return { ok: false, code: 'floor_too_high' };
  const epoch = Math.max(highest, f) + 1;
  return epoch > EPOCH_MAX ? { ok: false, code: 'epoch_limit' } : { ok: true, epoch };
}

/**
 * What a Host says it holds, whether or not its grant is live (it is the Host's own record, not MoMo's data): 'home' (running or moving), 'none', 'moved' (MoMo moved away from it: its data is gone; `movedTo` names the new home, `leaseEpoch` is that lease), 'retired' (a newer home superseded it: its data and key are KEPT, `lastActive` says when it last ran, and the owner may take it back), or 'unreadable' (the record cannot be read: that is no answer).
 * @param {Record | null} r @param {boolean} grantLive
 */
export function lookOf(r, grantLive) {
  if (!r) return { holds: /** @type {const} */ ('unreadable'), grantLive };
  if (r.state === 'none' && r.retired && r.movedTo)
    return {
      holds: /** @type {const} */ ('retired'),
      leaseEpoch: r.leaseEpoch,
      movedTo: r.movedTo,
      lastActive: r.retired.lastActive,
      grantLive,
    };
  if (r.state === 'none')
    return r.movedTo
      ? { holds: /** @type {const} */ ('moved'), leaseEpoch: r.leaseEpoch, movedTo: r.movedTo, grantLive }
      : { holds: /** @type {const} */ ('none'), leaseEpoch: r.leaseEpoch, grantLive };
  return { holds: /** @type {const} */ ('home'), homeId: r.homeId, leaseEpoch: r.leaseEpoch, name: r.name, state: r.state, grantLive };
}

/**
 * Whether a Host holding `r` stands down for the home `lease`: only a running or moving home of ANOTHER id whose lease the given one beats (a higher epoch, or the same epoch and the greater id). The same home, a Host with none and a lease that does not win change nothing and say so; an epoch more than FLOOR_STEP above anything this Host has seen is refused (a client's wrong memory must not retire a legitimate home).
 * @param {Record} r @param {{ homeId: string, leaseEpoch: number, name?: string }} lease @param {number} at @param {number} [known] the newest epoch this Host has seen in a stamp
 */
export function standDownRule(r, lease, at, known = 0) {
  // a home already retired by this winner at a lower lease takes the winner's real lease in further steps (the climb), within the same bound
  if (r.state === 'none' && r.retired && r.movedTo?.homeId === lease.homeId && lease.leaseEpoch > r.leaseEpoch)
    return lease.leaseEpoch > r.leaseEpoch + FLOOR_STEP
      ? { refused: /** @type {const} */ ('epoch_unproven') }
      : { raise: lease.leaseEpoch };
  if (r.state === 'none' || r.homeId === lease.homeId || !leaseWins(lease, r)) return { stoodDown: false, leaseEpoch: r.leaseEpoch };
  if (lease.leaseEpoch > Math.max(r.leaseEpoch, known) + FLOOR_STEP) return { refused: /** @type {const} */ ('epoch_unproven') };
  return {
    retire: {
      state: /** @type {const} */ ('none'),
      homeId: null,
      name: '',
      account: null,
      moveId: null,
      bundleHash: null,
      moveDeadline: null,
      targetSignKey: null,
      leaseEpoch: Math.max(r.leaseEpoch, lease.leaseEpoch),
      retired: { at, lastActive: r.lastSeenAt ?? at },
      movedTo: { name: lease.name || 'another machine', homeId: lease.homeId, at },
    },
  };
}

/** The first floor of a climb: the most a Host will take in one start. A floor further above than this is climbed in repeated starts (`next` ends when the home's epoch is above `target`), never sent as one number. @param {number} own @param {number} target */
export const climbFloor = (own, target) => Math.min(target, own + FLOOR_STEP);

/**
 * Whether a Host with record `r` takes a lease at `leaseEpoch` as the target of a move: it is no home and the lease is above its own record AND the newest stamp it has seen.
 * @param {Record} r @param {number} leaseEpoch @param {number} known
 * @returns {null | { code: 'retired_copy_here' | 'home_exists' | 'home_lease_stale', message: string, details?: object }}
 */
export function adoptRule(r, leaseEpoch, known) {
  if (r.retired) return { code: 'retired_copy_here', message: 'An older MoMo is still kept here. Use it or delete it first.' };
  if (r.state !== 'none') return { code: 'home_exists', message: `MoMo's home is ${r.name}.`, details: { name: r.name, homeId: r.homeId } };
  if (!(leaseEpoch > Math.max(r.leaseEpoch, known)))
    return { code: 'home_lease_stale', message: 'That lease is not newer than this one.', details: { leaseEpoch: r.leaseEpoch } };
  return null;
}

/**
 * What a Host does with a start (host/src/momoHome.mjs `start`), on the record as it is NOW: a refusal, "answered as it is", or the fields to write and the lease to take. `revive`: the owner takes back a RETIRED home (its data kept): it starts again above the current lease.
 * @param {Record} r @param {{ hostId: string, name: string, floor?: unknown, known: number, revive?: boolean }} i
 * @returns {{ refuse: { code: string, message: string, details?: object } } | { asis: true } | { set: Record<string, unknown>, epoch: number }}
 */
export function startRule(r, { hostId, name, floor, known, revive = false }) {
  const taking = r.state === 'none';
  if (taking && r.movedTo && !(revive && r.retired))
    return {
      refuse: {
        code: 'home_moved',
        message: `MoMo moved to ${r.movedTo.name}.`,
        details: { name: r.movedTo.name, homeId: r.movedTo.homeId },
      },
    };
  if (!taking && r.homeId !== hostId)
    return { refuse: { code: 'home_exists', message: `MoMo's home is ${r.name}.`, details: { name: r.name, homeId: r.homeId } } };
  // the same running home asking again with a floor at or above its epoch takes a new lease above it; with none (or while moving) it is answered as it is
  if (!taking && (r.state === 'moving' || floor === undefined || /** @type {number} */ (floor) < r.leaseEpoch)) return { asis: true };
  const e = startEpoch(r.leaseEpoch, floor, known);
  if (!e.ok) return { refuse: { code: e.code, message: 'That is not an epoch this machine can start above.' } };
  return { set: taking ? { homeId: hostId, name, state: 'running', movedTo: null, retired: null } : {}, epoch: e.epoch };
}

/**
 * Whether a Host with record `r` may be Reset by "Delete the old MoMo": only the copy that is still RETIRED at the epoch the owner saw. A home that was taken back (running again) or retired by another lease is refused, so the delete of one client can never wipe what another client just revived. A plain Reset (no precondition) is the owner's own, on a running home.
 * @param {Record | null} r the record, or null when it cannot be read (nothing is deleted on a record nobody could read) @param {{ ifRetired?: boolean, expectEpoch?: number } | undefined} pre
 * @returns {null | { code: 'retired_changed', message: string }}
 */
export function resetRule(r, pre) {
  if (!pre || !pre.ifRetired) return null;
  if (r && r.state === 'none' && r.retired && (pre.expectEpoch === undefined || r.leaseEpoch === pre.expectEpoch)) return null;
  return { code: 'retired_changed', message: 'That MoMo is not an older, retired copy any more, so nothing was deleted.' };
}

/** Whether a move may delete this machine's MoMo data: never a retired copy (the owner's to delete), and never on a record nobody could read. @param {Record | null} r */
export const mayWipe = (r) => !!r && !r.retired;

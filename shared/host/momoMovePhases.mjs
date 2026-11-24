// The rules of a move of MoMo's home, as pure functions (design 3.1, home lane): which step may happen in which state, and what it changes. The Host's move (host/src/momoMove.mjs) runs every step through one queue and applies these inside the write that re-reads the record, and the model test (tests/momoMoveModel.test.ts) enumerates sequences of the same steps, so the code and the proof cannot drift. Nothing here touches a disk, a clock or a key: callers pass `now` and what they verified (`proofOk`, `receiptOk`).

/** How long a move may take, on each Host's own clock; the old home's is the longer by a grace for the clocks' difference. */
export const MOVE_TTL_MS = 10 * 60_000;
export const MOVE_GRACE_MS = 2 * 60_000;
/** How many ended moves' ids a Host remembers, so a late step of one cannot pause the home again. */
export const CLOSED_KEEP = 20;

/** @typedef {{ error: { code: string, message: string, details?: object } }} Refusal */
/** @typedef {{ state: 'none' | 'running' | 'moving', leaseEpoch: number, moveId: string | null, bundleHash: string | null, moveDeadline: number | null, targetSignKey: string | null, closedMoves: string[], movedTo?: unknown, retired?: unknown }} OldRecord the fields of the home record a move reads */
/** @typedef {Refusal | { noop: true, keep?: true } | { again: true } | { set: Record<string, unknown>, epoch: false | number } | { wipe: true }} OldOutcome `epoch`: false keeps the lease, a number is the lease to give; `wipe`: the copy is deleted (the caller does it, then records the tombstone) */

/** @param {string} code @param {string} message @param {object} [details] @returns {Refusal} */
const refuse = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });
/** Whether the record is moving by this move. @param {OldRecord} r @param {string} moveId */
const isMoving = (r, moveId) => r.state === 'moving' && r.moveId === moveId;
/** Every step the old home took is undone, and the move's id is remembered as ended. @param {OldRecord} r */
const resumeFields = (r) => ({
  state: 'running',
  moveId: null,
  bundleHash: null,
  moveDeadline: null,
  targetSignKey: null,
  closedMoves: [...r.closedMoves, /** @type {string} */ (r.moveId)].slice(-CLOSED_KEEP),
});
/** Whether a move that sealed has run past its time. @param {OldRecord} r @param {number} now */
export const sealedAndExpired = (r, now) =>
  r.state === 'moving' && r.bundleHash !== null && r.moveDeadline !== null && now > r.moveDeadline;

/** The old home's side. Each rule takes the record as it is NOW (re-read inside the write) and says what to do. */
export const oldHome = {
  /** @param {OldRecord} r @param {{ moveId: string, now: number }} i @returns {OldOutcome} */
  begin(r, { moveId, now }) {
    if (r.state === 'none') return refuse('home_not_here', 'This machine is not MoMo’s home.');
    // a move that ended stays ended: a late or repeated begin of it does not pause the running home
    if (r.closedMoves.includes(moveId)) return refuse('move_closed', 'That move already ended.');
    if (r.state === 'moving') {
      if (r.moveId === moveId) return { again: true };
      return refuse(
        'move_in_progress',
        sealedAndExpired(r, now)
          ? 'Another move is open here and has not been settled with the other machine yet.'
          : 'Another move started.',
        { moveId: r.moveId },
      );
    }
    return {
      set: { state: 'moving', moveId, bundleHash: null, moveDeadline: now + MOVE_TTL_MS + MOVE_GRACE_MS, targetSignKey: null },
      epoch: false,
    };
  },
  /** A cancelled, expired or reclaimed move can never yield a bundle, and a move seals once (a second seal would make a bundle whose hash the target never received). @param {OldRecord} r @param {{ moveId: string, signKey: string, hash: string, now: number }} i @returns {OldOutcome} */
  seal(r, { moveId, signKey, hash, now }) {
    if (!isMoving(r, moveId)) return refuse('move_unknown', 'MoMo is not being moved by that move.');
    if (r.moveDeadline !== null && now > r.moveDeadline) return refuse('move_expired', 'That move took too long, so MoMo resumes here.');
    if (r.bundleHash !== null) return refuse('move_sealed', 'That move was already sealed.');
    return { set: { bundleHash: hash, targetSignKey: signKey }, epoch: false };
  },
  /** Before the seal nothing left this machine, so anyone may cancel; after it the target's signed discard is the only word that counts. @param {OldRecord} r @param {{ moveId: string, proofOk: boolean }} i @returns {OldOutcome} */
  cancel(r, { moveId, proofOk }) {
    if (r.state === 'running' && r.moveId === null) return { noop: true };
    if (!isMoving(r, moveId)) return refuse('move_unknown', 'MoMo is not being moved by that move.');
    if (r.bundleHash !== null && !proofOk)
      return refuse('move_not_given_up', 'The other machine has not said it gave the move up, so MoMo stays paused here until it does.');
    return { set: resumeFields(r), epoch: false };
  },
  /** A move that sealed nothing ends by itself when its time is out; one that sealed never does (the target may have switched). @param {OldRecord} r @param {{ now: number }} i @returns {OldOutcome} */
  expire(r, { now }) {
    if (r.state === 'moving' && r.bundleHash === null && r.moveDeadline !== null && now > r.moveDeadline)
      return { set: resumeFields(r), epoch: false };
    return { noop: true };
  },
  /**
   * The owner's own decision, for a target that is gone or disagrees: run here again at a lease HIGHER than the target could hold (its is
   * epoch + 1), so if the target ever returns, whatever it stamps is older than this home's and every receiver refuses it.
   * @param {OldRecord} r @param {{ moveId: string }} i @returns {OldOutcome}
   */
  reclaim(r, { moveId }) {
    if (!isMoving(r, moveId)) return refuse('move_unknown', 'MoMo is not being moved by that move.');
    return { set: resumeFields(r), epoch: r.leaseEpoch + 2 };
  },
  /** The copy is deleted only on the target's signed receipt for this move, lease, machine and bundle. @param {OldRecord} r @param {{ moveId: string, leaseEpoch: number, receiptOk: boolean }} i @returns {OldOutcome} */
  finish(r, { moveId, leaseEpoch, receiptOk }) {
    // a retired home's data is the owner's to delete (Reset) and nothing a move says may: it is never wiped here
    if (r.state === 'none' && r.retired) return { noop: true, keep: true };
    if (r.state === 'none' && r.movedTo && r.leaseEpoch >= leaseEpoch) return { noop: true };
    if (!isMoving(r, moveId)) return refuse('move_unknown', 'MoMo is not being moved by that move.');
    if (!(leaseEpoch > r.leaseEpoch)) return refuse('home_lease_stale', 'That lease is not newer than this one.');
    if (!receiptOk || !r.bundleHash || !r.targetSignKey)
      return refuse('receipt_invalid', 'The other machine has not confirmed it took MoMo over, so nothing here was deleted.');
    return { wipe: true };
  },
};

/** @typedef {{ phase: 'none' | 'offered' | 'received' | 'committed' | 'discarded', expiresAt: number }} TargetMove one move as the target holds it */
/** @typedef {Refusal | { ok: true, phase: TargetMove['phase'] } | { answer: 'committed' }} TargetOutcome */

/** The target's side. A move's offer is in exactly one phase, and exactly one of `committed` and `discarded` is ever reached for it. */
export const target = {
  /** @param {TargetMove | undefined} t @param {{ homeState: 'none' | 'running' | 'moving', now: number }} i @returns {TargetOutcome} */
  offer(t, { homeState, now }) {
    if (homeState !== 'none') return refuse('home_exists', 'MoMo already has a home here.');
    if (t?.phase === 'discarded') return refuse('move_discarded', 'That move was given up, so it cannot go on.');
    if (t && t.phase !== 'committed' && now <= t.expiresAt) return { ok: true, phase: t.phase };
    return { ok: true, phase: 'offered' };
  },
  /** @param {TargetMove | undefined} t @param {{ now: number }} i @returns {TargetOutcome} */
  receive(t, { now }) {
    if (!t) return refuse('move_unknown', 'This machine did not offer to take that move.');
    if (t.phase === 'discarded') return refuse('move_discarded', 'That move was given up, so it cannot go on.');
    if (t.phase === 'committed') return refuse('move_closed', 'That move already switched.');
    if (now > t.expiresAt) return refuse('move_expired', 'That move took too long, so nothing was changed.');
    return { ok: true, phase: 'received' };
  },
  /** The check is made again immediately before the record is written, under the same queue: a discard in between waits and then answers `committed`. @param {TargetMove | undefined} t @param {{ now: number, stageOwned: boolean }} i @returns {TargetOutcome} */
  commit(t, { now, stageOwned }) {
    if (!t) return refuse('move_unknown', 'This machine did not offer to take that move.');
    if (t.phase === 'committed') return { answer: 'committed' };
    if (t.phase === 'discarded') return refuse('move_discarded', 'That move was given up, so it cannot go on.');
    if (now > t.expiresAt) return refuse('move_expired', 'That move took too long, so nothing was changed.');
    if (t.phase !== 'received' || !stageOwned) return refuse('move_unknown', 'This machine has not received that move.');
    return { ok: true, phase: 'committed' };
  },
  /** @param {TargetMove | undefined} t @returns {TargetOutcome} */
  discard(t) {
    if (t?.phase === 'committed') return { answer: 'committed' };
    return { ok: true, phase: 'discarded' };
  },
};

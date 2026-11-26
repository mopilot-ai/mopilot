// The move as a screen drives it (W1.1 to W1.3): one move at a time, with its step, a Cancel until the switch, a Retry or Stay after a failure and an acknowledgement after one that finished. Over `moveHome` (shared/momoMove.mjs); the sides of a machine and its record come from the app, so the Mac and the phone share it. Nothing here is a transport.
import { moveHome, finishOld, recoverMove, MOVE_STEPS } from './momoMove.mjs';
import { moveView } from './momoHomeView.mjs';
import { IntentError } from './momoHomeApi.mjs';

/** A move can be cancelled until the switch starts. @param {string} step */
export const cancellable = (step) => MOVE_STEPS.indexOf(/** @type {any} */ (step)) < MOVE_STEPS.indexOf('switching');

/**
 * @param {object} o
 * @param {() => { id: string, name: string } | null} o.home the machine that is the home now
 * @param {(id: string) => { id: string, hostId?: string, name: string, side: import('./momoMove.mjs').MoveSide } | null} o.machine a machine and its Host's two calls (`hostId`: the id its Host named itself with, which the home record carries)
 * @param {() => string} o.newId a fresh move id
 * @param {() => void} o.changed the view changed
 * @param {typeof moveHome} [o.run]
 * @param {() => number} [o.now]
 */
export function createMoveRunner({ home, machine, newId, changed, run = moveHome, now = Date.now }) {
  /** @type {{ moveId: string, from: any, to: any, step: string, result: any, finishedAt: number | null, cancelled: boolean, running: boolean } | null} */
  let move = null;

  /** @param {string} toId */
  async function start(toId) {
    const from = home();
    const to = machine(toId);
    const source = from ? machine(from.id) : null;
    if (!from || !source) throw new IntentError('MoMo has no home to move from.');
    if (!to) throw new IntentError('That machine is not available.');
    if (to.id === from.id) throw new IntentError(`MoMo already lives on ${to.name}.`);
    if (move?.running) throw new IntentError('Another move is under way.');
    /** @type {NonNullable<typeof move>} */
    const mine = { moveId: newId(), from, to, step: MOVE_STEPS[0], result: null, finishedAt: null, cancelled: false, running: true };
    move = mine;
    changed();
    // the move runs on; the screens follow it through `changed` and read the result from the view
    void run({
      moveId: mine.moveId,
      from: source.side,
      to: to.side,
      target: { homeId: to.hostId ?? to.id, name: to.name },
      fromName: from.name,
      cancelled: () => mine.cancelled,
      step: (s) => {
        mine.step = s;
        changed();
      },
    }).then((result) => {
      mine.result = result;
      mine.finishedAt = now();
      mine.running = false;
      if (!result.ok) mine.step = result.step;
      changed();
    });
  }

  /**
   * A screen that names the move it is showing acts only on that move: a card left on a screen after one move ended and another began must not cancel,
   * retry, put away or dismiss the new one. A call without the id (a client that does not send it) acts on the move this runner holds.
   * @param {{ moveId?: string }} [which]
   */
  const mine = (which = {}) => {
    if (which.moveId && which.moveId !== move?.moveId) throw new IntentError('That move is over. The home was read again.');
  };

  const api = {
    start,
    /** Cancel, until the switch starts; after it the epoch has moved and the move is finished by its own steps. */
    cancel(/** @type {{ moveId?: string }} */ which = {}) {
      mine(which);
      if (!move?.running) throw new IntentError('There is no move to cancel.');
      if (!cancellable(move.step)) throw new IntentError('It is too late to cancel: the switch has started.');
      move.cancelled = true;
    },
    /**
     * Settle a move that did not finish and left the old home paused, on the target's signed word (`recoverMove`), from this device: it
     * switched (the old home is cleared), or it gave the move up (the old home resumes). `ownerAccepts`: the person confirmed the other
     * machine lost the move. @param {{ ownerAccepts?: boolean }} [how]
     */
    async recover({ ownerAccepts = false } = {}) {
      const m = move;
      if (!m || m.running) throw new IntentError('There is no move to settle.');
      const from = machine(m.from.id);
      const to = machine(m.to.id);
      if (!from || !to) throw new IntentError('One of the machines is not available.');
      const r = await recoverMove({
        moveId: m.moveId,
        from: from.side,
        to: to.side,
        target: { homeId: to.hostId ?? to.id, name: to.name },
        ownerAccepts,
      });
      if (r.state === 'uncertain') throw new IntentError(r.message);
      m.result =
        r.state === 'switched'
          ? { ok: true, oldHome: r.oldHome, leaseEpoch: r.leaseEpoch, receipt: r.receipt, homeId: r.homeId }
          : { ok: false, step: m.step, code: 'cancelled', message: 'The move was given up.', rolledBack: true };
      m.finishedAt = now();
      changed();
    },
    /**
     * THE owner's decision to run MoMo on the old home again (intent `{ kind: 'reclaim' }`), for both clients: the one place that asks the target
     * first (`recoverMove` with the owner's word), so no screen reimplements it. The target switched: the move is finished instead and the old copy
     * cleared; it gave the move up: the old home resumes on its signed proof; it cannot be reached or holds nothing of the move: the old home
     * runs again at a lease it could not hold. Without `moveId` and `toId` it settles the move this runner holds; a device that never ran the
     * move (or restarted) names it: the move id the Host's status shows and the machine MoMo was moving to.
     * @param {{ moveId?: string, toId?: string }} [which]
     * @returns {Promise<{ outcome: 'resumed' | 'switched' }>}
     */
    async reclaim({ moveId, toId } = {}) {
      const open = move && !move.running ? move : null;
      const id = moveId ?? open?.moveId;
      const targetId = toId ?? open?.to.id;
      if (!id || !targetId) throw new IntentError('There is no stuck move to settle: name the move and the machine it was going to.');
      const from = machine(open?.from.id ?? home()?.id ?? '');
      const to = machine(targetId);
      if (!from || !to) throw new IntentError('One of the machines is not available.');
      const r = await recoverMove({
        moveId: id,
        from: from.side,
        to: to.side,
        target: { homeId: to.hostId ?? to.id, name: to.name },
        ownerAccepts: true,
      });
      if (r.state === 'uncertain') throw new IntentError(r.message);
      if (open && open.moveId === id) {
        open.result =
          r.state === 'switched'
            ? { ok: true, oldHome: r.oldHome, leaseEpoch: r.leaseEpoch, receipt: r.receipt, homeId: r.homeId }
            : { ok: false, step: open.step, code: 'cancelled', message: 'MoMo runs on its old machine again.', rolledBack: true };
        open.finishedAt = now();
      }
      changed();
      return { outcome: r.state === 'switched' ? 'switched' : 'resumed' };
    },
    /** The old machine was offline at the end of a move that did switch: clear it now that it may be back (the target's receipt is kept for this). */
    async retryPending() {
      const m = move;
      const r = m?.result;
      if (!m || !r?.ok || r.oldHome !== 'offline') throw new IntentError('Nothing is waiting to be cleared.');
      const from = machine(m.from.id);
      const to = machine(m.to.id);
      if (!from || !to) throw new IntentError('One of the machines is not available.');
      const done = await finishOld({
        moveId: m.moveId,
        from: from.side,
        leaseEpoch: r.leaseEpoch,
        name: to.name,
        homeId: r.homeId ?? to.hostId ?? to.id,
        receipt: r.receipt,
      });
      if (done === 'offline') throw new IntentError(`${from.name} did not answer, so it still holds a copy.`);
      m.result = { ...r, oldHome: 'cleared' };
      changed();
    },
    /** Try a move that did not finish again, to the same machine. */
    async retry(/** @type {{ moveId?: string }} */ which = {}) {
      mine(which);
      if (!move || move.running || move.result?.ok !== false) throw new IntentError('There is no move to try again.');
      // the move that failed may have left the old home paused (its Cancel or the target's answer was lost): it is settled with the target first,
      // so the new move does not meet "Another move started" from its own stale one (F1)
      if (move.result.rolledBack === false) {
        await api.recover();
        // it switched after all: there is nothing to try again
        if (move.result?.ok) throw new IntentError(`MoMo had already moved to ${move.to.name}.`);
      }
      await start(move.to.id);
    },
    /** Stay: a failed move is put away; the old home runs as it did. */
    stay(/** @type {{ moveId?: string }} */ which = {}) {
      mine(which);
      if (!move || move.running || move.result?.ok !== false) throw new IntentError('There is no move to put away.');
      move = null;
      changed();
    },
    /** "Got it" after a move that finished. */
    acknowledge(/** @type {{ moveId?: string }} */ which = {}) {
      mine(which);
      if (!move || move.running) throw new IntentError('There is no finished move to dismiss.');
      move = null;
      changed();
    },
    /** How the last move ended (null while it runs or when none ran) and the machine it was to. */
    result: () => (move && !move.running ? move.result : null),
    target: () => move?.to.id ?? null,
    /** The move as the home view shows it, null when none is under way or just ended. */
    view: () =>
      move
        ? moveView({
            moveId: move.moveId,
            from: { machineId: move.from.id, name: move.from.name },
            to: { machineId: move.to.id, name: move.to.name },
            step: move.step,
            result: move.result,
            finishedAt: move.finishedAt,
          })
        : null,
  };
  return api;
}

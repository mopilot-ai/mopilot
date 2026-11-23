// The client's side of moving MoMo's home (design 3.1, steps W1.1 to W1.3): pause, seal, copy, switch, clean up, driven over two Hosts' `host.momoMove` steps. Pure of any transport: `from` and `to` are `{ call(op, params) }` (and `to.status()`), so the Mac app, the phone and the tests drive it the same way. Before the switch every failure and a Cancel roll back (the old home runs again at the same epoch, the target discards what it received); the switch is the one step whose outcome is confirmed with the target before anything else is done, so a move can end with the old home or the new one, never both and never neither running by a guess.

/** The steps a person sees, in order (W1.1). */
export const MOVE_STEPS = Object.freeze(['paused', 'sealed', 'copied', 'switching', 'resuming', 'cleaning-up']);

/**
 * @typedef {object} MoveSide
 * @property {(op: string, params?: object) => Promise<any>} call one `host.momoMove` step on that Host
 * @property {() => Promise<{ home: { homeId: string, leaseEpoch: number, state: string } | null }>} [status] `host.momoStatus` of it (not needed to decide a move: the target's own signed word does)
 */
/**
 * @typedef {{ ok: true, oldHome: 'cleared' | 'offline', leaseEpoch: number, receipt: string, homeId: string } | { ok: false, step: string, code: string, message: string, rolledBack: boolean, uncertain?: boolean }} MoveResult
 * `oldHome: 'offline'`: the new home runs and the old machine still holds a copy; the person is told, and `finishOld` (with the `receipt`) clears it when it is back.
 * `uncertain`: the target could not be asked whether it switched, so the old home stays paused until the target is asked again or the owner reclaims.
 */

/** What a Host answers when it did not pause for this move. */
const REFUSED_BEGIN = ['home_not_here', 'move_in_progress', 'move_closed'];

/** A Host's refusal as the person reads it. @param {unknown} e @returns {{ code: string, message: string }} */
const whyOf = (e) => ({
  code: String(/** @type {any} */ (e)?.code ?? 'failed'),
  message: String(/** @type {any} */ (e)?.message ?? 'It did not finish.'),
});

/**
 * @param {object} o
 * @param {string} o.moveId made once by the client; every step is safe to send again with it
 * @param {MoveSide} o.from the machine that is the home now
 * @param {MoveSide} o.to the machine to move to
 * @param {{ homeId: string, name: string }} o.target the machine the person chose, as the app knows it
 * @param {string} o.fromName the old home's name, for the audit entry on the new one
 * @param {() => boolean} [o.cancelled] true once the person pressed Cancel (read between steps, up to the switch)
 * @param {(step: string) => void} [o.step] each step as it starts
 * @returns {Promise<MoveResult>}
 */
export async function moveHome({ moveId, from, to, target, fromName, cancelled = () => false, step = () => undefined }) {
  /**
   * Where a move that did not finish stands, by the target's own word: `discard` tombstones the move there (a bundle or a switch that
   * arrives late is refused) or tells that the switch already happened. Nothing is decided from an error or a guess.
   * @returns {Promise<{ state: 'given-up', proof: string | null } | { state: 'switched', receipt: string, leaseEpoch: number, homeId?: string } | { state: 'unknown' }>}
   */
  const settle = async () => {
    try {
      const d = await to.call('discard', { moveId });
      return d.committed
        ? { state: 'switched', receipt: d.receipt, leaseEpoch: d.leaseEpoch }
        : { state: 'given-up', proof: d.proof ?? null };
    } catch {
      return { state: 'unknown' };
    }
  };
  /**
   * Before the switch: the target gives the move up, and only then does the old home resume (with the target's signed proof once it had
   * sealed). A target that cannot be asked leaves the old home paused: a sealed move never resumes on a clock (the target may have switched), so
   * it is settled later on the target's word, or by the owner's Reclaim. @param {{ paused: boolean }} how
   */
  const rollBack = async ({ paused }) => {
    const t = await settle();
    if (t.state === 'switched') return { switched: t };
    if (t.state === 'unknown') return { rolledBack: false, uncertain: true };
    if (!paused) return { rolledBack: true };
    try {
      await from.call('cancel', { moveId, ...(t.proof ? { proof: t.proof } : {}) });
      return { rolledBack: true };
    } catch {
      return { rolledBack: false, uncertain: true };
    }
  };
  /** @param {string} at @param {unknown} error @param {{ paused: boolean }} how @returns {Promise<MoveResult>} */
  const fail = async (at, error, how) => {
    const r = await rollBack(how);
    // it had switched after all: the move is done, and the old home is cleared on the target's receipt
    if (r.switched) return done(r.switched.leaseEpoch, r.switched.receipt, r.switched.homeId);
    return { ok: false, step: at, ...whyOf(error), rolledBack: !!r.rolledBack, ...(r.uncertain ? { uncertain: true } : {}) };
  };
  /** The new home runs; the old one is cleared on the target's receipt. @param {number} leaseEpoch @param {string} receipt @returns {Promise<MoveResult>} */
  const done = async (leaseEpoch, receipt, homeId = target.homeId) => {
    // the new home runs from here (its services start with the switch); the old one is then cleared
    step('resuming');
    step('cleaning-up');
    return {
      ok: true,
      // the machine's own id, as it answered: the app's record of it may be stale, and the old copy is wiped only against the id the receipt names
      oldHome: await finishOld({ moveId, from, leaseEpoch, name: target.name, homeId, receipt }),
      leaseEpoch,
      receipt,
      homeId,
    };
  };
  const cancel = { code: 'cancelled', message: 'You cancelled the move.' };

  step('paused');
  // the target is asked first, so its time runs out before the old home's: when the old home resumes by itself, the target cannot switch
  /** @type {any} */
  let offer;
  try {
    offer = await to.call('offer', { moveId });
  } catch (e) {
    return { ok: false, step: 'paused', ...whyOf(e), rolledBack: true };
  }
  /** @type {any} */
  let began;
  try {
    began = await from.call('begin', { moveId });
  } catch (e) {
    // a typed refusal means nothing was paused by this move (another move holds it, it ended, or this machine is no home): only the target's offer
    // is given up. Anything else (no answer, a lost answer) may have paused it: the old home is asked to resume too, which is safe before a seal (F13)
    return fail('paused', e, { paused: !REFUSED_BEGIN.includes(/** @type {any} */ (e)?.code) });
  }
  const epoch = began.home.leaseEpoch;
  if (cancelled()) return fail('paused', cancel, { paused: true });

  step('sealed');
  let sealed;
  try {
    sealed = await from.call('seal', { moveId, targetKey: offer.targetKey, signKey: offer.signKey });
  } catch (e) {
    return fail('sealed', e, { paused: true });
  }
  if (cancelled()) return fail('sealed', cancel, { paused: true });

  step('copied');
  try {
    await to.call('receive', { moveId, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
  } catch (e) {
    return fail('copied', e, { paused: true });
  }
  if (cancelled()) return fail('copied', cancel, { paused: true });

  // the switch: from here a Cancel is no longer offered
  step('switching');
  const leaseEpoch = epoch + 1;
  /** @type {any} */
  let switched;
  try {
    switched = await to.call('commit', { moveId, leaseEpoch, homeId: target.homeId, name: target.name, from: fromName });
  } catch (e) {
    // the answer may have been lost after the target switched: the target is asked, and it either switched (the move goes on), gave
    // the move up for good (the old home resumes), or cannot be asked (nobody runs on a guess)
    return fail('switching', e, { paused: true });
  }
  return done(leaseEpoch, switched.receipt, switched.homeId);
}

/**
 * Clear the old home after the switch: it deletes its copy and key and keeps a tombstone, on the target's signed receipt. When it
 * cannot be reached the new home already runs; this is tried again when the machine is back (the client keeps the pending call).
 * @param {{ moveId: string, from: MoveSide, leaseEpoch: number, name: string, homeId: string, receipt: string }} o
 * @returns {Promise<'cleared' | 'offline'>}
 */
export async function finishOld({ moveId, from, leaseEpoch, name, homeId, receipt }) {
  try {
    await from.call('finish', { moveId, leaseEpoch, name, homeId, receipt });
    return 'cleared';
  } catch {
    return 'offline';
  }
}

/**
 * A move whose driving client is gone, or that ended with the old home still paused (it sealed and its time ran out, so it does not resume on
 * a clock: the target may have switched): ask the target and settle it on the target's signed word, from any device that can reach both.
 * The target switched: the old home is cleared on its receipt. The target gave the move up: the old home resumes on its proof. The target
 * holds nothing of the move (it lost the offer): the old home resumes only on the owner's own confirmation (`ownerAccepts`). The target
 * cannot be asked: nothing changes.
 * @param {{ moveId: string, from: MoveSide, to: MoveSide, target: { homeId: string, name: string }, ownerAccepts?: boolean }} o
 * @returns {Promise<{ state: 'switched', oldHome: 'cleared' | 'offline', leaseEpoch: number, receipt: string, homeId: string } | { state: 'resumed' } | { state: 'uncertain', code: string, message: string }>}
 */
export async function recoverMove({ moveId, from, to, target, ownerAccepts = false }) {
  /** @type {any} */
  let said;
  try {
    said = await to.call('discard', { moveId });
  } catch (e) {
    // a target that cannot be reached at all may be reclaimed from on the owner's own word; one that answered with a refusal may not
    if (ownerAccepts && !typedRefusal(e)) return reclaimFrom({ moveId, from, target: 'unreachable' });
    return { state: 'uncertain', ...whyOf(e) };
  }
  if (said.committed) {
    const homeId = said.homeId ?? target.homeId;
    const oldHome = await finishOld({ moveId, from, leaseEpoch: said.leaseEpoch, name: target.name, homeId, receipt: said.receipt });
    return { state: 'switched', oldHome, leaseEpoch: said.leaseEpoch, receipt: said.receipt, homeId };
  }
  try {
    // the target gave the move up and said so (signed): the old home resumes at its own lease. A target that holds nothing of the move
    // cannot sign, so only the owner's own decision, which runs MoMo here at a lease the target cannot hold, ends it
    if (said.proof) await from.call('cancel', { moveId, proof: said.proof });
    else if (ownerAccepts) await from.call('reclaim', { moveId, ownerConfirmed: true, target: 'lost' });
    else return { state: 'uncertain', code: 'move_not_given_up', message: 'The other machine could not say it gave the move up.' };
    return { state: 'resumed' };
  } catch (e) {
    return { state: 'uncertain', ...whyOf(e) };
  }
}

/** Whether an error is a Host's own refusal (a code in lower case), as opposed to a connection that failed. @param {any} e */
const typedRefusal = (e) => typeof e?.code === 'string' && /^[a-z][a-z0-9_]+$/.test(e.code);

/** The owner's word, sent to the old home: only after the target was asked (`target` says what it answered). @param {{ moveId: string, from: MoveSide, target: 'unreachable' | 'lost' }} o @returns {Promise<{ state: 'resumed' } | { state: 'uncertain', code: string, message: string }>} */
async function reclaimFrom({ moveId, from, target }) {
  try {
    await from.call('reclaim', { moveId, ownerConfirmed: true, target });
    return { state: 'resumed' };
  } catch (e) {
    return { state: 'uncertain', ...whyOf(e) };
  }
}

/**
 * The owner's decision for a target that is gone or disagrees: MoMo runs on the old home again, at a lease the target could not hold, so
 * the copy on the target will be refused by every receiver if that machine ever returns. The target is asked FIRST: one that switched means
 * the move is finished instead (never reclaimed), one that gave up resumes the old home on its proof, and only one that cannot be reached or
 * holds nothing of the move is reclaimed from. The words a screen shows before the tap come from `reclaimWords`.
 * @param {{ moveId: string, from: MoveSide, to: MoveSide, target: { homeId: string, name: string } }} o
 */
export const reclaimHere = ({ moveId, from, to, target }) => recoverMove({ moveId, from, to, target, ownerAccepts: true });

/** What the confirmation says before the owner runs MoMo here again: the consequence, in the machine's own name. @param {string} targetName @param {string} homeName */
export const reclaimWords = (targetName, homeName) => ({
  title: `Run MoMo on ${homeName} again?`,
  body: `The copy on ${targetName} will be refused if it ever comes back. Anything it did there since the move began is not kept.`,
  confirm: `Run on ${homeName}`,
});

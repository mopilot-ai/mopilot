// The Host's handlers for the `host.momo*` methods (feature `momo`, M1): the grant, the status and starting a home. MoMo is veiled: to a client that is not paired, or while no live grant of an invited account is held (host/src/momoHome.mjs), every one (the grant only needs a paired client) is a request no Host knows, and the feature is not in the hello, so an uninvited client sees nothing of MoMo.
import { HostRefusal } from '../hostFs.mjs';
import { momoDeliveryView } from '../../../shared/momoDeliveryView.mjs';

import { isOwner } from '../momoOwner.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  /** @param {unknown} principal */
  const paired = (principal) => !!momo && !!principal;
  /** @param {unknown} principal */
  const seen = (principal) => paired(principal) && !!momo?.granted();
  /** Everything that changes MoMo's home or shows its data beyond the status: the owner's own devices only, never the local CLI (any process on this machine). @param {unknown} principal */
  const owner = (principal) => seen(principal) && isOwner(principal);
  /** The handlers run only for a client the veil let through, so there is a home. */
  const home = /** @type {NonNullable<typeof momo>} */ (momo);
  /** A part of the home this Host has not made yet (the serve entry makes them) is a refusal, not a crash. @template T @param {T | null} part @returns {T} */
  const needed = (part) => {
    if (!part) throw new HostRefusal('momo_home_away', `MoMo's home is not ready on ${home.machine()}.`);
    return part;
  };
  return {
    veils: {
      'host.momoGrant': (/** @type {unknown} */ principal) => paired(principal) && isOwner(principal),
      'host.momoStatus': seen,
      'host.momoHomeStart': owner,
      'host.momoChat': owner,
      'host.momoPrefs': owner,
      'host.momoMemory': owner,
      'host.momoBriefNow': owner,
      'host.momoIntent': owner,
      'host.momoTurn': owner,
      'host.momoMove': owner,
      'host.momoReset': owner,
    },
    // which chats are MoMo's and who may see them: the protocol's chat veil (./chatVeil.mjs) holds every chat request, result and event to it
    chatRules: momo?.chats?.rules,
    // `momoHome` only while this Host is the running home: a Host that is not (none, moving, asleep to a client) does not claim it
    features: { momo: seen, momoHome: (/** @type {unknown} */ principal) => seen(principal) && !!momo?.stamp() },
    handlers: {
      'host.momoGrant': (/** @type {{ account: string, features: string[] }} */ p) => home.grant(p),
      // what this Host holds, and whether it can tell MoMo's chats from the rest right now
      'host.momoStatus': () => ({
        ...home.status(),
        ...(home.chats ? { chats: home.chats.state() } : {}),
        ...(home.scheduler ? { scheduler: home.scheduler.status() } : {}),
        // the day (brief, catch-up) and what is wrong with a phone's pushes, each with its cause and one-tap fix
        ...(home.daily ? { day: home.daily.status() } : {}),
        ...(home.push ? { delivery: home.push.failures() } : {}),
        // the brief settings, notification permission and every delivery problem in the view contract's shape (shared/momoDeliveryView.mjs)
        ...(home.push && home.daily
          ? {
              view: momoDeliveryView({
                prefs: home.prefs.forRoutines(),
                day: home.daily.status(),
                pushProblems: home.push.failures(),
                reachedAPhone: home.push.reachedAny(),
              }),
            }
          : {}),
      }),
      // MoMo's memory for the Memory page: the facts, the newest changes, and an undo (a change made since is refused, as in the app)
      'host.momoMemory': (/** @type {{ op: 'list' | 'changes' | 'undo', id?: string }} */ p) => home.memory(p),
      // what the home's routines read; a client that may see MoMo sets it (all optional: none named just reads them)
      'host.momoPrefs': (/** @type {object} */ p) => home.prefs.change(p),
      'host.momoTurn': (/** @type {{ turnId: string }} */ p) => home.turn(p.turnId),
      'host.momoBriefNow': () => needed(home.daily).briefNow(),
      'host.momoIntent': (/** @type {{ key: string, action: 'draft' | 'remind' | 'dismiss', at?: number }} */ p) =>
        needed(home.intents).apply(p),
      'host.momoReset': () => home.reset(),
      // one step of a move (host/src/momoMove.mjs): the op names it, the rest are its parameters
      'host.momoMove': (
        /** @type {{ op: 'begin' | 'seal' | 'cancel' | 'reclaim' | 'finish' | 'offer' | 'receive' | 'commit' | 'discard' } & Record<string, any>} */ p,
        _kind,
        /** @type {{ principal?: () => { fingerprint: string } | null }} */ who,
      ) => /** @type {any} */ (home.move)[p.op](p.op === 'reclaim' ? { ...p, by: who?.principal?.()?.fingerprint ?? null } : p),
      'host.momoHomeStart': (/** @type {{ homeId: string, name: string }} */ p) => home.start(p),
      'host.momoChat': (/** @type {{ harness: string }} */ p) => /** @type {NonNullable<typeof home.chats>} */ (home.chats).start(p),
    },
  };
};

// What a client (the Mac, the phone) does with what the paired Hosts say they hold (home lane): which Hosts hold a home, which home it uses, who stands down, whether it may offer to create one or to take an older one back, and how a lease is climbed to. The SAME functions run in both clients and in the model test (tests/momoHomeSafetyModel.test.ts), so "at most one live home" is one rule, not two readings of a document. The Host's side is ./momoHomeSafety.mjs.
import { climbFloor, EPOCH_MAX, leaseWins } from './momoHomeSafety.mjs';

/** The first Host app version that could hold a home at all (the one the home record first shipped in): an older version holds none, so a Host that old and with no look is a definite "no home". A build id has no order, so only a release version is read (the registry's `hostAppVersion`). */
export const FIRST_HOME_VERSION = '0.4.60';
/** The oldest Host release a client lets hold a home: every start says it (`minVersion`) and a Host older than it refuses with `host_too_old` (#5626), whatever the client made of its version. The first release with the signed-entitlement gate a home's grant goes through (#5506); raise it when a home needs more of its Host. */
export const HOME_MIN_HOST_VERSION = '0.4.67';
/** How old a Host's reported version may be and still decide "holds none": longer ago, and it may have been updated and given a home since. */
export const VERSION_FRESH_MS = 10 * 60_000;

/** A release version as numbers, or null for anything else ("dev", "local", "", a build id, garbage): such a Host is never "too old to hold a home". @param {unknown} v @returns {number[] | null} */
export const releaseOf = (v) => (typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v) ? v.split('.').map(Number) : null);
/** Whether release `a` is older than release `b`; false when either is not a release. @param {unknown} a @param {string} b */
export const olderRelease = (a, b) => {
  const [x, y] = [releaseOf(a), releaseOf(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return /** @type {number} */ (x[i]) < /** @type {number} */ (y[i]);
  return false;
};

/**
 * One paired machine as the client saw it this round.
 * @typedef {{
 *   id: string,
 *   hasHost: boolean,            a Host is installed (a machine with no Host at all holds nothing)
 *   reachable: boolean,
 *   lookFeature: boolean,        the hello advertised `momoLook` (a build that can answer Look whatever its grant)
 *   version: string | null,      the registry's `hostAppVersion`, a release version or ''/null when unknown
 *   versionFresh: boolean,       it was reported within VERSION_FRESH_MS
 *   look: undefined | null | import('./momoHomeSafety.d.mts').Look,   undefined: not asked yet; null: refused, timed out or failed
 * }} Machine
 */

const isEpoch = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * What one machine said, as the client reads it: 'home' (holds a home), 'none' (holds none, or is too old to have held one, or has no Host), 'retired' (holds none, but an older MoMo is KEPT there: its data and key) or 'unheard' (will not say: unreachable, refused, unreadable, malformed, a value this client does not know, or a build that may hold a home but cannot be asked). 'moved' counts as holding none and keeps where MoMo went. A look not made yet is 'pending'.
 * @param {Machine} m
 */
export function answerOf(m) {
  /** @param {string} kind @param {object} [more] */
  const a = (kind, more = {}) => ({ kind, id: m.id, ...more });
  if (!m.hasHost) return a('none');
  if (!m.reachable) return a('unheard');
  if (!m.lookFeature) {
    // a Host that cannot be asked: only a fresh, readable release older than the first with a home is known to hold none
    return m.versionFresh && olderRelease(m.version, FIRST_HOME_VERSION) ? a('none') : a('unheard');
  }
  if (m.look === undefined) return a('pending');
  const l = /** @type {any} */ (m.look);
  if (!l || typeof l !== 'object') return a('unheard');
  if (l.holds === 'home' && isEpoch(l.leaseEpoch) && typeof l.homeId === 'string' && l.homeId)
    return a('home', { homeId: l.homeId, leaseEpoch: l.leaseEpoch, name: typeof l.name === 'string' ? l.name : '', state: l.state });
  if ((l.holds === 'none' || l.holds === 'moved' || l.holds === 'retired') && isEpoch(l.leaseEpoch)) {
    if (l.holds === 'none') return a('none', { leaseEpoch: l.leaseEpoch });
    if (!l.movedTo || typeof l.movedTo.homeId !== 'string') return a('unheard');
    return a(l.holds === 'retired' ? 'retired' : 'none', {
      leaseEpoch: l.leaseEpoch,
      movedTo: l.movedTo,
      ...(l.holds === 'retired' ? { lastActive: Number.isFinite(l.lastActive) ? l.lastActive : 0 } : {}),
    });
  }
  return a('unheard');
}

/**
 * @typedef {{ call: 'host.momoHomeStart', host: string, params: { name: string, floor: number, climbTo: number, revive?: boolean } }
 *   | { call: 'host.momoStandDown', host: string, params: { homeId: string, leaseEpoch: number | null, name?: string, own?: number } }} Step
 * a stand-down with `leaseEpoch: null` waits for the lease the start before it ACTUALLY got (see `execute`)
 */

/**
 * The client's decision for this round.
 * @param {Machine[]} machines
 * @param {{ seen: number, chosen?: string | null, freshConfirmed?: boolean }} memory `freshConfirmed`: the owner confirmed Start fresh and is picking the machine; `seen`: the highest epoch this client has ever seen on any Host (0 when it restarted with none); `chosen`: the home the owner accepted with accept-lease
 */
export function decide(machines, memory) {
  const answers = /** @type {any[]} */ (machines.map(answerOf));
  const homes = answers.filter((a) => a.kind === 'home');
  const unheard = answers.filter((a) => a.kind === 'unheard').map((a) => a.id);
  const pending = answers.some((a) => a.kind === 'pending');
  const moved = answers.filter((a) => a.kind === 'none' && a.movedTo).map((a) => a.id);
  const retired = answers.filter((a) => a.kind === 'retired');
  // the floor a new lease must clear: everything this client has seen, now or before, a home's epoch or a tombstone's
  const floor = Math.min(
    EPOCH_MAX,
    Math.max(isEpoch(memory.seen) ? memory.seen : 0, ...homes.map((h) => h.leaseEpoch), ...answers.map((a) => a.leaseEpoch ?? 0)),
  );
  let winner = /** @type {any} */ (null);
  if (homes.length) {
    const chosen = memory.chosen ? homes.find((h) => h.homeId === memory.chosen) : null;
    winner = chosen ?? homes.reduce((best, h) => (leaseWins(h, best) ? h : best));
  }
  /** @type {Step[]} */
  const steps = [];
  /** @type {null | { kind: 'move-in-progress', host: string, name: string }} nothing to run yet, and why: a winner that is moving waits for its move */
  let blocked = null;
  /** The loser homes the owner is told were replaced, and whether one was mid-move. @type {{ host: string, name: string, moving: boolean }[]} */
  const replaced = [];
  if (winner) {
    const losers = homes.filter((h) => h !== winner);
    // the winner must be above every loser: an older copy the owner chose, or a tie, takes a new lease first (a start of the same home above the highest loser)
    const top = Math.max(0, ...losers.map((h) => h.leaseEpoch));
    const relese = losers.length > 0 && top >= winner.leaseEpoch;
    if (relese && winner.state === 'moving') {
      // a home that is moving is never given a new lease under its move: wait for the move to end or be cancelled, and say so
      blocked = { kind: 'move-in-progress', host: winner.id, name: winner.name };
    } else {
      if (relese)
        steps.push({
          call: 'host.momoHomeStart',
          host: winner.id,
          params: { name: winner.name, floor: climbFloor(winner.leaseEpoch, top), climbTo: top },
        });
      for (const l of losers) {
        steps.push({
          call: 'host.momoStandDown',
          host: l.id,
          params: { homeId: winner.homeId, leaseEpoch: relese ? null : winner.leaseEpoch, name: winner.name, own: l.leaseEpoch },
        });
        replaced.push({ host: l.id, name: l.name, moving: l.state === 'moving' });
      }
    }
  }
  const none = homes.length === 0 && !pending;
  return {
    homes: homes.map((h) => h.homeId),
    winner: winner ? winner.homeId : null,
    floor,
    steps,
    /** @type {{ host: string, name: string, moving: boolean }[]} the homes retired this round, so the owner is told which MoMo was kept and that the other is retired with its data kept (a home that was moving says its move was replaced) */
    replaced,
    blocked,
    // the machine picker: for a plain choose; for Start fresh only once the owner confirmed it ('confirm' asks first), so a confirmed Start fresh never loops back to the question
    picker: /** @type {'choose' | 'confirm' | 'fresh' | null} */ (
      none && unheard.length === 0 && moved.length === 0 && retired.length === 0
        ? 'choose'
        : none
          ? memory.freshConfirmed
            ? 'fresh'
            : 'confirm'
          : null
    ),
    /** Older MoMos kept on retired machines, to tell the owner once: where, when it last ran, and where MoMo went. */
    older: retired.map((r) => ({ host: r.id, lastActive: r.lastActive, movedTo: r.movedTo })),
    // plain "choose this machine": every Host with MoMo answered "holds none", and none is a tombstone naming a home nobody holds now, nor a retired copy
    offerChoose: none && unheard.length === 0 && moved.length === 0 && retired.length === 0,
    // "Start fresh": no home was heard; every reachable Host has been looked at; the owner confirms that an unheard machine, a tombstone or a kept older MoMo may still matter
    offerStartFresh: none && (unheard.length > 0 || moved.length > 0 || retired.length > 0),
    unheard,
    moved,
  };
}

/**
 * The steps that create a home on `host`: one start above everything seen (climbed to in repeated starts when the floor is far above this Host's own epoch).
 * @param {ReturnType<typeof decide>} d @param {{ id: string, name: string, own?: number }} host
 * @returns {Step[]}
 */
export const createSteps = (d, host) => [
  { call: 'host.momoHomeStart', host: host.id, params: { name: host.name, floor: climbFloor(host.own ?? 0, d.floor), climbTo: d.floor } },
];

/**
 * The steps that take a RETIRED home back: it starts again above every live home (its data kept), and each live home then stands down at the lease it actually got.
 * @param {ReturnType<typeof decide>} d @param {{ id: string, name: string, own: number }} host the retired machine @param {{ id: string, homeId: string, leaseEpoch: number, name: string }[]} live
 * @returns {Step[]}
 */
export function reviveSteps(d, host, live) {
  const top = Math.max(d.floor, ...live.map((h) => h.leaseEpoch));
  return [
    {
      call: 'host.momoHomeStart',
      host: host.id,
      params: { name: host.name, floor: climbFloor(host.own, top), climbTo: top, revive: true },
    },
    ...live.map(
      (/** @type {{ id: string, name: string }} */ l) =>
        /** @type {Step} */ ({ call: 'host.momoStandDown', host: l.id, params: { homeId: '', leaseEpoch: null, name: host.name } }),
    ),
  ];
}

/** The most starts one climb makes: a floor is climbed `FLOOR_STEP` at a time, so this reaches far past any epoch a person's machines will ever have; past it the climb stops and says so. */
export const CLIMB_MAX = 200;

/**
 * Run steps in order through `call` (`(step) => Promise<{ ok: true, leaseEpoch: number, homeId?: string } | { ok: false, code: string }>`). A start is repeated, each time with the floor a Host will take, until the home's lease is above `climbTo`; a stand-down uses the lease the start ACTUALLY returned, and the stand-downs run only when the start succeeded: when it failed nobody is stood down and the failure is returned.
 * @param {Step[]} steps @param {(step: Step) => Promise<{ ok: true, leaseEpoch: number, homeId?: string } | { ok: false, code: string }>} call
 * @returns {Promise<{ ok: true, lease: number | null } | { ok: false, code: string, at: Step }>}
 */
export async function execute(steps, call) {
  /** @type {number | null} */
  let lease = null;
  let homeId = '';
  for (const step of steps) {
    if (step.call === 'host.momoHomeStart') {
      let r = await call(step);
      let n = 1;
      while (r.ok && r.leaseEpoch <= step.params.climbTo && n++ < CLIMB_MAX)
        r = await call({ ...step, params: { ...step.params, floor: climbFloor(r.leaseEpoch, step.params.climbTo) } });
      if (!r.ok) return { ok: false, code: r.code, at: step };
      if (r.leaseEpoch <= step.params.climbTo) return { ok: false, code: 'climb_failed', at: step };
      lease = r.leaseEpoch;
      homeId = r.homeId ?? homeId;
    } else {
      const target = step.params.leaseEpoch ?? lease;
      if (target === null) return { ok: false, code: 'no_lease', at: step };
      const base = { ...step.params, homeId: step.params.homeId || homeId };
      // a stand-down is climbed too: a Host takes a lease only so far above what it knows, so a far winner retires it in steps, the last at the winner's real lease
      let at = climbFloor(step.params.own ?? target, target);
      for (let n = 0; n < CLIMB_MAX; n++) {
        const r = await call(/** @type {Step} */ ({ ...step, params: { ...base, leaseEpoch: at } }));
        // a stand-down that is refused (the Host knows no better lease) leaves that home as it is; the next look decides again
        // …and a step that made no progress (the Host answered below the lease it was given: that home was already retired or reset) ends the climb
        if (!r.ok || r.leaseEpoch >= target || r.leaseEpoch < at) break;
        at = climbFloor(r.leaseEpoch, target);
      }
    }
  }
  return { ok: true, lease };
}

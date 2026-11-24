// The wire methods of MoMo's home on a Host (M1, designs/momo-m1-home): the feature a Host that can be MoMo's home declares, the grant of an invited account, the home record and its status; an older Host has none, so an app is never sent a `momo.*` method it would drop. Everything but the grant needs a live grant, EXCEPT `host.momoHomeLook` and `host.momoStandDown` (feature `momoLook`, advertised to a paired owner device whatever the grant): what a Host holds is presence only, and a client that read a missing grant as "no home" could start a second one.

import { PROACTIVITY, parseClock } from '../../momoRoutine.mjs';
import { parseKind } from '../../harnessKind.mjs';

/** The feature both ends declare; a method below needs it, so a Host without it is refused, never served half. */
export const MOMO_FEATURE = 'momo';
/** Offered only by a Host that runs MoMo's home right now (and only to a client that may see MoMo): the clients show the home screens on it. */
export const MOMO_HOME_FEATURE = 'momoHome';
/** Advertised to the owner's devices whatever the grant: this Host can say what it holds (`host.momoHomeLook`). A Host without it may still hold a home, so a client reads its silence as "not heard". */
export const MOMO_LOOK_FEATURE = 'momoLook';

/** A grant that is not one is refused as a request no Host knows, so a client with no grant learns nothing from its mistakes. */
const UNKNOWN_GRANT = 'Unknown request: host.momoGrant';
const HOME_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The agents MoMo's brain may be asked for; the Host says which of them it can keep apart from the coding side. */
/** A turn id is the key the device made for its send. */
export const TURN_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
/** A move's id, made by the client that drives it. */
const MOVE_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The move's steps, each answered by one Host (host/src/momoMove.mjs): begin, seal, cancel and finish by the old home; offer, receive, commit and discard by the new one. */
const MOVE_OPS = ['begin', 'seal', 'cancel', 'reclaim', 'finish', 'offer', 'receive', 'commit', 'discard'];
/** A sealed bundle (base64) is at most this long: one wire frame is 8 MB. */
const MAX_SEALED = 7 * 1024 * 1024;
/** What a notification action or a card names: the opaque key of the matter or card (the notice lane's), not a chat or a mail id. */
const INTENT_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The one-tap answers of a notification (design Function 3): draft the reply, remind me later, not needed. */
export const INTENTS = /** @type {const} */ (['draft', 'remind', 'dismiss']);
/** @param {string} zone whether the platform knows this IANA zone */
const validZone = (zone) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
/** The agents MoMo's brain may be asked for are the harness kinds the app knows (shared/harnessKind.mjs), whichever they are: which of them a Host can keep apart is its own answer at start. */
const BRAIN = /^[a-z][a-z0-9:._-]{0,80}$/;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  /** @param {unknown} v */
  const nameOf = (v) => {
    if (typeof v !== 'string' || !v || v.length > 80) throw bad('That is not a machine name.');
    return v;
  };
  return {
    features: [MOMO_FEATURE, MOMO_HOME_FEATURE, MOMO_LOOK_FEATURE],
    methods: {
      // an invited account's client says so (and again every 30 minutes); a Host answers every other momo.* as unknown until it has one
      'host.momoGrant': {
        access: 'open',
        requires: [],
        parse: (/** @type {any} */ p) => {
          if (typeof p.account !== 'string' || !p.account || p.account.length > 200) throw bad(UNKNOWN_GRANT);
          if (!Array.isArray(p.features) || p.features.length > 50 || p.features.some((/** @type {unknown} */ f) => typeof f !== 'string'))
            throw bad(UNKNOWN_GRANT);
          // an entitlement the account service signed (the server-signed grant): optional until it is required, and a bad one is as unknown as a bad grant
          if (p.entitlement !== undefined && (typeof p.entitlement !== 'string' || !p.entitlement || p.entitlement.length > 2048))
            throw bad(UNKNOWN_GRANT);
          return { account: p.account, features: p.features, ...(p.entitlement === undefined ? {} : { entitlement: p.entitlement }) };
        },
      },
      // whether this Host is MoMo's home, and at which epoch (the home record)
      'host.momoStatus': { access: 'open', requires: [MOMO_FEATURE], parse: () => ({}) },
      // MoMo's main chat on one agent of this Host: the chat's id, to be sent to with chat.send
      'host.momoChat': {
        access: 'open',
        requires: [MOMO_FEATURE, 'epoch'],
        parse: (/** @type {any} */ p) => {
          const harness = matchOf(p.harness, BRAIN, 'That is not an agent.');
          if (!parseKind(harness)) throw bad('That is not an agent.');
          return { harness };
        },
      },
      // how often MoMo reaches out, its quiet hours and whether it is paused: what its routines on this Host read (all optional; none named reads them back)
      'host.momoPrefs': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const out =
            /** @type {{ proactivity?: string, quietHours?: { start: string, end: string } | null, paused?: boolean, brief?: object, notify?: object }} */ ({});
          if (p.proactivity !== undefined) {
            if (!PROACTIVITY.includes(p.proactivity)) throw bad('That is not a way to reach out.');
            out.proactivity = p.proactivity;
          }
          if (p.quietHours !== undefined) {
            const q = p.quietHours;
            if (q !== null && (parseClock(q?.start) === null || parseClock(q?.end) === null)) throw bad('Those are not quiet hours.');
            out.quietHours = q === null ? null : { start: q.start, end: q.end };
          }
          if (p.paused !== undefined) {
            if (typeof p.paused !== 'boolean') throw bad('Paused is yes or no.');
            out.paused = p.paused;
          }
          // the morning brief: the switch, its time ("HH:MM") and the zone it is read on (a zone the platform knows)
          if (p.brief !== undefined) {
            const b = p.brief;
            const brief = /** @type {{ on?: boolean, time?: string, zone?: string }} */ ({});
            if (b?.on !== undefined) {
              if (typeof b.on !== 'boolean') throw bad('The brief is on or off.');
              brief.on = b.on;
            }
            if (b?.time !== undefined) {
              if (parseClock(b.time) === null) throw bad('That is not a time for the brief.');
              brief.time = b.time;
            }
            if (b?.zone !== undefined) {
              if (typeof b.zone !== 'string' || !validZone(b.zone)) throw bad('That is not a time zone.');
              brief.zone = b.zone;
            }
            out.brief = brief;
          }
          // push: lock-screen text (opt-in) and the most tell-now pushes a day
          if (p.notify !== undefined) {
            const n = p.notify;
            const notify = /** @type {{ previews?: boolean, tellNowMax?: number }} */ ({});
            if (n?.previews !== undefined) {
              if (typeof n.previews !== 'boolean') throw bad('Previews are on or off.');
              notify.previews = n.previews;
            }
            if (n?.tellNowMax !== undefined) {
              if (!Number.isInteger(n.tellNowMax) || n.tellNowMax < 1 || n.tellNowMax > 50)
                throw bad('That is not a number of messages a day.');
              notify.tellNowMax = n.tellNowMax;
            }
            out.notify = notify;
          }
          return out;
        },
      },
      // what the home kept of a turn a device sent (design 1, the turn ledger): accepted, completed, failed, cancelled, interrupted, or unknown
      'host.momoTurn': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => ({ turnId: matchOf(p.turnId, TURN_ID, 'That is not a turn id.') }),
      },
      // what MoMo remembers, as the Memory page shows it: the facts, the newest changes (a save a chat made on a Host is one of them) and an undo of one
      'host.momoMemory': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (!['list', 'changes', 'undo'].includes(p.op)) throw bad('That is not a thing to ask of MoMo’s memory.');
          if (p.op !== 'undo') return { op: p.op };
          if (typeof p.id !== 'string' || !p.id || p.id.length > 200) throw bad('That is not a change.');
          return { op: 'undo', id: p.id };
        },
      },
      // Reset MoMo on this Host: every file its stores kept is deleted and the home goes on, empty
      // `ifRetired`/`expectEpoch`: "Delete the old MoMo": only a copy still retired at that epoch is deleted (a revive that landed first is refused)
      'host.momoReset': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => ({
          ...(p.ifRetired === true ? { ifRetired: true } : {}),
          ...(Number.isSafeInteger(p.expectEpoch) && p.expectEpoch >= 0 ? { expectEpoch: p.expectEpoch } : {}),
        }),
      },
      // one step of moving MoMo's home (design 3.1): the old home pauses, seals, cancels or finishes; the new one offers a key, receives, commits or discards
      'host.momoMove': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          const op = MOVE_OPS.find((o) => o === p.op);
          if (!op) throw bad('That is not a step of a move.');
          const moveId = matchOf(p.moveId, MOVE_ID, 'That is not a move id.');
          /** @param {unknown} v @param {string} what */
          const text = (v, what) => {
            if (typeof v !== 'string' || !v || v.length > MAX_SEALED) throw bad(`That is not ${what}.`);
            return v;
          };
          /** @param {unknown} v */
          const lease = (v) => {
            if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 1) throw bad('That is not a lease epoch.');
            return /** @type {number} */ (v);
          };
          if (op === 'seal') return { op, moveId, targetKey: text(p.targetKey, 'a move key'), signKey: text(p.signKey, 'a signing key') };
          if (op === 'cancel')
            return {
              op,
              moveId,
              ...(p.proof === undefined || p.proof === null ? {} : { proof: text(p.proof, 'a proof') }),
            };
          // the owner's own decision, said in full: never a bare flag, and never for a target that switched (that move is finished, not reclaimed)
          if (op === 'reclaim') {
            if (p.ownerConfirmed !== true) throw bad('That is not the owner’s decision.');
            if (p.target !== 'unreachable' && p.target !== 'lost')
              throw bad('Say whether the other machine could not be reached or holds nothing of the move.');
            return { op, moveId, ownerConfirmed: true, target: p.target };
          }
          if (op === 'receive')
            return {
              op,
              moveId,
              sealed: text(p.sealed, 'a bundle'),
              bundleHash: matchOf(p.bundleHash, /^[0-9a-f]{64}$/, 'That is not a bundle hash.'),
            };
          if (op === 'finish')
            return {
              op,
              moveId,
              leaseEpoch: lease(p.leaseEpoch),
              name: nameOf(p.name),
              homeId: matchOf(p.homeId, HOME_ID, 'That is not a home id.'),
              receipt: text(p.receipt, 'a receipt'),
            };
          if (op === 'commit')
            return {
              op,
              moveId,
              leaseEpoch: lease(p.leaseEpoch),
              name: nameOf(p.name),
              from: nameOf(p.from),
            };
          return { op, moveId };
        },
      },
      // "Show it now" / "Resume" on a brief that did not start or failed: made at once; one already delivered today is left as it is
      'host.momoBriefNow': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: () => ({}),
      },
      // a notification's own buttons (Draft a reply, Remind me at 4, Not needed) as a typed answer; answering one clears it on the other devices
      'host.momoIntent': {
        access: 'open',
        requires: [MOMO_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (!INTENTS.includes(p.action)) throw bad('That is not something a notification can do.');
          const out = /** @type {{ key: string, action: typeof INTENTS[number], at?: number }} */ ({
            key: matchOf(p.key, INTENT_KEY, 'That is not a notification.'),
            action: p.action,
          });
          if (p.at !== undefined) {
            if (p.action !== 'remind' || !Number.isFinite(p.at) || p.at <= 0) throw bad('That is not a time to remind.');
            out.at = p.at;
          }
          return out;
        },
      },
      // make this Host MoMo's home; refused while another home exists
      'host.momoHomeStart': {
        access: 'open',
        requires: [MOMO_FEATURE],
        // the home is this Host: a `homeId` a client sends is not read, so it cannot name another machine
        // `floor`: the highest lease epoch the caller has seen on any Host (absent: none); the new home starts above it and above this Host's own; `revive`: take back a retired home
        parse: (/** @type {any} */ p) => ({
          name: nameOf(p.name),
          ...(p.floor === undefined
            ? {}
            : {
                floor:
                  Number.isSafeInteger(p.floor) && p.floor >= 0
                    ? p.floor
                    : (() => {
                        throw bad('That is not an epoch.');
                      })(),
              }),
          // the owner takes back a retired home (its data kept) instead of starting an empty one
          ...(p.revive === true ? { revive: true } : {}),
        }),
      },
      // what this Host holds (a home, none, moved away, or unreadable) and whether its grant is live: answered with no grant, to the owner's devices only
      // (the deliberate exception to "MoMo is veiled": it answers a paired owner device even for an uninvited account, presence only, no MoMo data)
      'host.momoHomeLook': { access: 'open', requires: [MOMO_LOOK_FEATURE], parse: () => ({}) },
      // a newer home exists at a higher epoch: a running or moving home here of another id and a lower epoch is retired
      'host.momoStandDown': {
        access: 'open',
        requires: [MOMO_LOOK_FEATURE],
        parse: (/** @type {any} */ p) => ({
          homeId: matchOf(p.homeId, /^[A-Za-z0-9:._-]{1,200}$/, 'That is not a home id.'),
          leaseEpoch:
            Number.isSafeInteger(p.leaseEpoch) && p.leaseEpoch > 0
              ? p.leaseEpoch
              : (() => {
                  throw bad('That is not an epoch.');
                })(),
          ...(p.name === undefined ? {} : { name: nameOf(p.name) }),
        }),
      },
    },
  };
};

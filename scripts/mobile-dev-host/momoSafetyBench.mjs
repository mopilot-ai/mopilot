// DEV ONLY: the home-safety states of MoMo's home as a dev host serves them to the phone (older MoMo, a replaced move, a move in progress, a home that cannot be found): the problems are built by the same shared functions the Mac's composition uses (shared/momoHomeOlder.mjs, shared/momoHomeLook.mjs), so the words are theirs, and the buttons answer as the Mac does: Use and Delete are asked first, Keep and Check again do their one thing.
import { createOlder } from '../../shared/momoHomeOlder.mjs';
import { leaseProblems } from '../../shared/momoHomeLook.mjs';
import { createConfirmations } from '../../shared/momoHomeConfirm.mjs';
import { startFreshWords } from '../../shared/momoHomeFix.mjs';
import { parseFixId } from '../../shared/momoFixId.mjs';
import { createMail } from '../../shared/momoHomeMail.mjs';
import { createMomoOutbox } from '../../shared/momoOutbox.mjs';

export const SAFETY = Object.freeze(['older', 'replaced', 'blocked', 'home-lost', 'unheard', 'held-old', 'older-colon']);

const AT = Date.now() - 26 * 3_600_000;
const mini = { machine: { id: 'mini', name: 'Mac mini' }, status: { home: { lastSeenAt: Date.now() - 60_000, name: 'Mac mini' } } };
const runner = {
  machine: { id: 'ssh:runner@localhost', name: 'Runner' },
  movedTo: { homeId: 'mini-home', at: AT },
  lastActive: AT,
  leaseEpoch: 4,
};
const studio = { machine: { id: 'studio', name: 'Studio' }, movedTo: { homeId: 'mini-home', at: AT }, lastActive: AT, leaseEpoch: 4 };

/** A machine of the scripted world as the app's list gives it: answering, set up, up to date. @param {string} id @param {string} name */
const machine = (id, name) => ({
  id,
  hostId: `${id}-home`,
  name,
  isThisDevice: false,
  reachable: true,
  current: true,
  stays: /** @type {const} */ ('on'),
  setUp: true,
  hasHost: true,
  agents: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: true }],
});

/** A refusal of the home as the intent answer carries it: the cause in its words and the one tap that fixes it. @param {any} error */
const refusal = (error) => ({ ok: false, cause: error.message, fix: error.fix, fixLabel: error.fixLabel });

/** The scripted world one state stands on, and what the owner's choices have done to it. */
/** @param {{ firstRun?: () => void }} [o] firstRun: what the home does once a fresh start is confirmed (it asks where MoMo should live) */
export function createSafetyBench({ firstRun = () => undefined } = {}) {
  /** @type {string | null} */
  let state = null;
  let older = [studio];
  const kept = new Set();
  /**
   * A message the owner typed while MoMo slept, held for the MoMo that was there, after Start fresh: the shared mail module (shared/momoHomeMail.mjs) with a new home
   * chosen since, so its words and its two choices (Send to this MoMo, Delete message) are the Mac's.
   */
  let entries = /** @type {any[]} */ ([]);
  const mail = createMail({
    outbox: createMomoOutbox({
      store: { read: () => entries.map((e) => ({ ...e })), write: (e) => void (entries = e.map((x) => ({ ...x }))) },
      now: Date.now,
    }),
    sent: { read: () => [], write: Function.prototype.bind.call(Function.prototype, null) },
    now: Date.now,
    // the bench sends nothing: these answer if it ever did (built-ins bound to their answer, not code of their own)
    send: Promise.resolve.bind(Promise),
    chatOn: Promise.resolve.bind(Promise, { chatId: 'bench', epoch: 1 }),
    report: Function.prototype.bind.call(Function.prototype, null),
    alive: Boolean.bind(null, true),
    epoch: () => 0,
    lineage: () => ['home-new'],
  });
  const confirm = createConfirmations({ now: Date.now, newId: () => Math.random().toString(36).slice(2, 8) });
  const read = async () =>
    /** @type {any} */ ({
      home: state === 'home-lost' || state === 'unheard' ? null : mini,
      older,
      live: [],
      decision: { homes: [], steps: [], blocked: null, replaced: [], offerStartFresh: false },
    });
  const handler = createOlder({
    read,
    invalidate: () => undefined,
    confirm,
    memory: { read: () => [...kept], write: (k) => (kept.clear(), k.forEach((x) => kept.add(x))) },
    run: async () => ({ failure: null }),
    // the machines of the scripted world: both answer, set up and up to date, so the older one is fit to be used
    machines: () => [machine('studio', 'Studio'), machine('mini', 'Mac mini'), machine('ssh:runner@localhost', 'Runner')],
    call: async () => ({}),
  });
  const world = () => ({
    home: state === 'home-lost' || state === 'unheard' ? null : mini,
    older,
    lost: state === 'home-lost',
    status: { home: { name: 'Studio' } },
    note: null,
    tombstone: null,
    unheard: state === 'unheard' ? [{ name: 'Studio' }] : [],
    decision: {
      blocked: state === 'blocked' ? { kind: 'move-in-progress' } : null,
      winner: null,
      picker: 'choose',
      offerStartFresh: state === 'home-lost' || state === 'unheard',
    },
  });
  return {
    /** @param {string | null} next */
    show(next) {
      state = next;
      older = next === 'older' || next === 'replaced' ? [studio] : next === 'older-colon' ? [runner] : [];
      kept.clear();
      handler.forget();
      entries = [];
      if (next === 'held-old') {
        // written while MoMo slept, with no home it was written for; the owner started fresh since
        void mail.take({ turnId: 'turn-held-0001', text: 'Remind me about Dana', home: null, homeId: '' });
        mail.holdForOld(undefined);
      }
      if (next === 'replaced') handler.retired([{ host: 'studio', moving: true }]);
    },
    /** The problems of the state, in the view's shape. */
    problems() {
      if (!state) return [];
      const r = /** @type {any} */ (world());
      return [...handler.problems(r), ...leaseProblems(r), ...mail.problems()];
    },
    /** One fix the view offered: null when this bench does not own it. @param {any} raw @returns {Promise<{ ok: boolean, cause?: string, fix?: object, fixLabel?: string } | null>} */
    async fix(raw) {
      if (!state || raw?.kind !== 'fix' || typeof raw.id !== 'string') return null;
      if (raw.id === 'check-again') return { ok: true };
      // the owner's two choices for a message held for the old MoMo: send it to this one, or delete it
      const fix = parseFixId(raw.id);
      if (fix?.kind === 'retry-send') {
        mail.retry(fix.fields[0], 'home-new');
        entries = [];
        return { ok: true };
      }
      if (fix?.kind === 'delete-send') {
        mail.discard(fix.fields[0]);
        return { ok: true };
      }
      // Start fresh is asked first, in the shared words, and only the confirming press acts; then the home asks where MoMo should live
      if (fix?.kind === 'start-fresh' || fix?.kind === 'start-fresh!') {
        try {
          if (raw.id === 'start-fresh')
            confirm.ask(
              'start-fresh',
              startFreshWords('Studio', state === 'unheard' ? 'Studio' : 'a machine'),
              'start-fresh!',
              '',
              'Start fresh',
            );
          confirm.consume('start-fresh', fix.fields[0]);
          state = null;
          firstRun();
          return { ok: true };
        } catch (error) {
          return refusal(error);
        }
      }
      if (!/^(keep-older|use-older|delete-older)!?:/.test(raw.id)) return null;
      try {
        await handler(raw.id);
        // a use or a delete that was confirmed has happened: the older MoMo is gone from the list
        if (/^(use|delete)-older!/.test(raw.id)) older = [];
        return { ok: true };
      } catch (error) {
        return refusal(error);
      }
    },
  };
}

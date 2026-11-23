// The Host's side of a continue on another Host: prepare a native session here (the source is untouched), commit the owner change by one CAS on the source's epoch, release the source, and refuse a chat's writes once it moved (docs: design/host/index.html, package 3.1).
import { CONTINUE_CODES as C, ContinueRefusal } from '../../shared/host/continue.mjs';
import { StaleEpochError } from './epochs.mjs';
import { INDETERMINATE } from './ledger.mjs';

/** How long a preparation waits for its commit before the target reclaims it. */
const PREPARED_TTL_MS = 30 * 60_000;

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {ReturnType<typeof import('./ledger.mjs').createLedger>} o.ledger
 * @param {ReturnType<typeof import('./owners.mjs').createOwnerStore>} o.owners
 * @param {object} o.target what this Host does as a target (the harness adapters and directories; wired with the protocol, 2.3 part 4b)
 * @param {(a: { harness: string, cwd: string }) => Promise<string>} o.target.check the real directory, or throws the structured refusal (`harness_not_configured`, `directory_missing`)
 * @param {(a: { chatId: string, harness: string, cwd: string, handoff: string }) => Promise<{ nativeId: string }>} o.target.open opens the native session with the handoff
 * @param {(nativeId: string) => Promise<void>} o.target.discard closes a session a preparation opened
 * @param {(rec: { chatId: string, nativeId: string, harness: string, cwd: string, epoch: number }) => void} [o.target.serve] binds the prepared session to the chat when it becomes the owner
 * @param {(chatId: string) => boolean} o.serves this Host is running the chat now: it cannot be the target of its own chat
 * @param {(chatId: string) => boolean} o.busy a turn is running, or a write is in flight, for the chat
 * @param {(chatId: string) => Promise<void> | void} o.quiesce lets in-flight work for the chat settle before the commit looks again
 * @param {(chatId: string) => Promise<void>} o.retire the Host stops what it still runs or serves for a chat that moved away or was poisoned (a running turn, live subscribers)
 * @param {(problem: string) => void} o.report where a failure that must not stop the work around it is reported
 * @param {() => string} o.newId mints a preparation id (shape of a key)
 * @param {() => number} [o.now]
 * @param {number} [o.ttlMs]
 */
export function createContinueHost({
  epochs,
  ledger,
  owners,
  target,
  serves,
  busy,
  quiesce,
  retire,
  report,
  newId,
  now = Date.now,
  ttlMs = PREPARED_TTL_MS,
}) {
  /** The one prepare per chat running now, by its key (a retry of the same one joins it). @type {Map<string, { key: string }>} */
  const preparing = new Map();
  /** The one commit per chat running now, by preparation: a retry of the same one joins it. @type {Map<string, { preparedId: string, promise: Promise<any> }>} */
  const committing = new Map();

  const refuse = (/** @type {string} */ code, /** @type {string} */ message, /** @type {Record<string, unknown>} */ details = {}) =>
    new ContinueRefusal(code, message, details);
  const inFlight = () => refuse(C.inFlight, 'Another continue of this chat is already under way.');

  /** The answer for a commit that already happened for this preparation, else null; a commit for another target is refused. @param {{ chatId: string, targetHostId: string, preparedId: string }} p */
  function replay(p) {
    const rec = owners.get(p.chatId);
    if (rec?.state !== 'released' || rec.preparedId !== p.preparedId) return null;
    if (rec.targetHostId !== p.targetHostId) throw refuse(C.targetMismatch, 'That preparation was committed to another host.');
    // the owner record is the commit point; the epoch file follows it, and a crash between the two is healed here
    epochs.admit(p.chatId, rec.epoch);
    return { epoch: rec.epoch, targetHostId: rec.targetHostId, preparedId: rec.preparedId, replayed: true };
  }

  /** A chat prepared here becomes the owner when a request carries its epoch (or a newer one). @param {string} chatId @param {Extract<import('./owners.mjs').OwnerRecord, { state: 'prepared' }>} rec */
  function activate(chatId, rec) {
    target.serve?.({ chatId, nativeId: rec.nativeId, harness: rec.harness, cwd: rec.cwd, epoch: rec.epoch });
    // the epoch first: a crash between the two leaves a record that activates again, never a chat with an owner and no epoch
    epochs.admit(chatId, rec.epoch);
    owners.remove(chatId);
  }

  /** Forgets a preparation and closes its session; a session that will not close keeps its record, so a later sweep tries again. @param {string} chatId @param {Extract<import('./owners.mjs').OwnerRecord, { state: 'prepared' }>} rec */
  async function drop(chatId, rec) {
    owners.remove(chatId);
    try {
      await target.discard(rec.nativeId);
    } catch (e) {
      if (!owners.get(chatId)) owners.put(chatId, rec);
      throw e;
    }
  }

  /** The chat's record after a request with `epoch` arrived: a preparation that epoch reaches is activated and is no record any more. @param {string} chatId @param {number} epoch */
  function arrive(chatId, epoch) {
    const rec = owners.get(chatId);
    if (rec?.state !== 'prepared' || epoch < rec.epoch) return rec;
    activate(chatId, rec);
    return null;
  }

  /** The commit proper: everything here that decides runs with no await between the last look and the owner write. @param {{ chatId: string, expectedEpoch: number, targetHostId: string, preparedId: string }} p */
  async function settle(p) {
    const done = replay(p);
    if (done) return done;
    await quiesce(p.chatId);
    // the Host may have changed while it settled: look again
    const again = replay(p);
    if (again) return again;
    const rec = owners.get(p.chatId);
    if (rec?.state === 'released')
      throw refuse(C.released, 'This chat was already handed to another host.', { targetHostId: rec.targetHostId, epoch: rec.epoch });
    if (rec?.state === 'poisoned')
      throw refuse(C.poisoned, 'This chat was continued on another host while this one was away.', { epoch: rec.epoch });
    // a chat prepared here that the client already owns at its epoch is activated by this very request
    arrive(p.chatId, p.expectedEpoch);
    if (busy(p.chatId)) throw refuse(C.turnRunning, 'The chat is busy. Wait for it to finish, or stop it, then try again.');
    const current = epochs.current(p.chatId);
    if (current !== p.expectedEpoch) throw new StaleEpochError(p.chatId, p.expectedEpoch, current);
    owners.put(p.chatId, {
      state: 'released',
      epoch: current + 1,
      preparedId: p.preparedId,
      targetHostId: p.targetHostId,
      cleaned: false,
      at: now(),
    });
    epochs.admit(p.chatId, current + 1);
    return { epoch: current + 1, targetHostId: p.targetHostId, preparedId: p.preparedId, replayed: false };
  }

  return {
    /**
     * Prepares a native session for the chat on this Host and returns its `preparedId`; nothing about the chat's owner changes.
     * @param {{ chatId: string, epoch: number, key: string, harness: string, cwd: string, handoff: string }} p
     */
    async prepare(p) {
      const open = preparing.get(p.chatId);
      if (open && open.key !== p.key) throw inFlight();
      const mine = open ?? { key: p.key };
      preparing.set(p.chatId, mine);
      try {
        const { replayed, result } = await ledger.once({ chatId: p.chatId, key: p.key, method: 'chat.prepareContinue' }, async () => {
          // a chat this Host handed away (or lost) is no longer its to run, whatever its runtime still holds
          const here = owners.get(p.chatId)?.state;
          if (serves(p.chatId) && here !== 'released' && here !== 'poisoned')
            throw refuse(C.sameHost, 'This host is already running that chat.');
          const stale = () => {
            const current = epochs.current(p.chatId);
            if (p.epoch <= current) return new StaleEpochError(p.chatId, p.epoch, current);
            // a newer preparation (another client's) is not replaced by an older one
            const held = owners.get(p.chatId);
            return held?.state === 'prepared' && held.epoch > p.epoch ? new StaleEpochError(p.chatId, p.epoch, held.epoch) : null;
          };
          const early = stale();
          if (early) throw early;
          const cwd = await target.check({ harness: p.harness, cwd: p.cwd });
          const { nativeId } = await target.open({ chatId: p.chatId, harness: p.harness, cwd, handoff: p.handoff });
          // another owner may have taken the chat while the session opened
          const late = stale();
          if (late) {
            await target.discard(nativeId);
            throw late;
          }
          const prior = owners.get(p.chatId);
          const preparedId = newId();
          owners.put(p.chatId, { state: 'prepared', epoch: p.epoch, preparedId, harness: p.harness, cwd, nativeId, at: now() });
          // a replaced preparation's session is closed after the new one is on record
          if (prior?.state === 'prepared')
            await target
              .discard(prior.nativeId)
              .catch((/** @type {Error} */ e) => report(`A replaced preparation did not close: ${e.message}`));
          return { preparedId, epoch: p.epoch, cwd };
        });
        if (result === INDETERMINATE)
          throw refuse(C.prepareUnsettled, 'That preparation did not finish before the host restarted. Try again.');
        return { .../** @type {object} */ (result), replayed };
      } finally {
        // a replacement that started meanwhile owns the slot now
        if (preparing.get(p.chatId) === mine) preparing.delete(p.chatId);
      }
    },

    /**
     * The commit: one CAS on this Host's owner record for the chat. Retrying a lost reply with the same preparation gets the same answer.
     * @param {{ chatId: string, expectedEpoch: number, targetHostId: string, preparedId: string }} p
     */
    commit(p) {
      const open = committing.get(p.chatId);
      if (open) {
        if (open.preparedId === p.preparedId) return open.promise;
        return Promise.reject(inFlight());
      }
      const mine = { preparedId: p.preparedId, promise: /** @type {Promise<any>} */ (settle(p)) };
      committing.set(p.chatId, mine);
      const clear = () => committing.get(p.chatId) === mine && committing.delete(p.chatId);
      mine.promise.then(clear, clear);
      return mine.promise;
    },

    /**
     * Best effort cleanup: the target reclaims a preparation that did not become the owner; the source finishes a hand-over. A preparation that is not here is a no-op.
     * @param {{ chatId: string, epoch: number, preparedId: string }} p
     */
    async release(p) {
      const rec = owners.get(p.chatId);
      if (!rec || rec.state === 'poisoned' || rec.preparedId !== p.preparedId || rec.epoch !== p.epoch) return { released: 'noop' };
      if (rec.state === 'prepared') {
        await drop(p.chatId, rec);
        return { released: 'reclaimed' };
      }
      if (!rec.cleaned) {
        await retire(p.chatId);
        // marked only once the cleanup ran, and only if the record is still this hand-over
        const now = owners.get(p.chatId);
        if (now?.state === 'released' && now.preparedId === rec.preparedId) owners.put(p.chatId, { ...now, cleaned: true });
      }
      return { released: 'finalized' };
    },

    /**
     * A request that carries the chat's epoch reached this Host: a chat prepared here becomes the owner when the epoch is its own or newer. Reads call this; they are still served for a chat that moved.
     * @param {string} chatId @param {number} epoch
     */
    touch(chatId, epoch) {
      arrive(chatId, epoch);
    },

    /**
     * Whether a write for the chat may run: throws when it may not (the chat moved, was poisoned, is not served here yet, or a commit is under way).
     * @param {string} chatId @param {number} epoch
     */
    gate(chatId, epoch) {
      if (committing.has(chatId)) throw inFlight();
      const rec = arrive(chatId, epoch);
      if (!rec) return;
      if (rec.state === 'released')
        throw refuse(C.released, 'This chat was handed to another host.', { targetHostId: rec.targetHostId, epoch: rec.epoch });
      if (rec.state === 'poisoned')
        throw refuse(C.poisoned, 'This chat was continued on another host while this one was away.', { epoch: rec.epoch });
      throw refuse(C.notServing, 'This host is not serving that chat yet.', { epoch: rec.epoch });
    },

    /**
     * The client's hello names the chats it moved away from this Host while it was gone. Each one this Host still thinks it owns is poisoned: it serves nothing for it, and the client reads its tail. One it had already handed to that same host is `agreed`.
     * @param {{ chatId: string, epoch: number, rev: number, targetHostId: string }[]} moved
     */
    async acceptHello(moved) {
      /** @type {{ chatId: string, epoch: number }[]} */
      const poisoned = [];
      /** @type {{ chatId: string, epoch: number, targetHostId: string }[]} */
      const conflicts = [];
      /** @type {{ chatId: string, epoch: number }[]} */
      const agreed = [];
      for (const m of moved) {
        const rec = owners.get(m.chatId);
        // this Host handed the chat to the same host at the same epoch (the app only did not hear): nothing to poison. To a different host: two owners claim it, which only the user can settle
        if (rec?.state === 'released' && rec.epoch === m.epoch) {
          if (rec.targetHostId === m.targetHostId) agreed.push({ chatId: m.chatId, epoch: m.epoch });
          else conflicts.push({ chatId: m.chatId, epoch: m.epoch, targetHostId: rec.targetHostId });
        } else if (m.epoch > epochs.current(m.chatId)) {
          owners.put(m.chatId, { state: 'poisoned', epoch: m.epoch, at: now() });
          epochs.admit(m.chatId, m.epoch);
          poisoned.push({ chatId: m.chatId, epoch: m.epoch });
          // what this Host still runs or serves for the chat stops with it
          await retire(m.chatId).catch((/** @type {Error} */ e) => report(`A poisoned chat was not retired: ${e.message}`));
          if (rec?.state === 'prepared')
            await target
              .discard(rec.nativeId)
              .catch((/** @type {Error} */ e) => report(`A voided preparation did not close: ${e.message}`));
        }
      }
      return { poisoned, conflicts, agreed };
    },

    /** Reclaims the preparations that never became the owner within the time limit; returns how many. One that will not close is reported and tried again at the next sweep. */
    async sweep() {
      let n = 0;
      for (const [chatId, rec] of owners.entries())
        if (rec.state === 'prepared' && now() - rec.at > ttlMs && owners.get(chatId)?.state === 'prepared')
          try {
            await drop(chatId, rec);
            n++;
          } catch (e) {
            report(`An expired preparation did not close: ${/** @type {Error} */ (e).message}`);
          }
      return n;
    },
  };
}

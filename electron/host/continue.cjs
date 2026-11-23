// The app's side of continuing a chat on another Host: prepare on the target, commit by the source Host's CAS, record the new owner only after the commit succeeded, release the source, or (source gone, user agrees) advance the epoch itself and reconcile when the source returns (docs: design/host/index.html, package 3.1).
const { CONTINUE_CODES: C, ContinueRefusal } = require('../../shared/host/continue.mjs');

/** What a Host refuses with when the commit certainly did not happen. */
const DEFINITE = new Set([
  'stale_epoch',
  C.turnRunning,
  C.inFlight,
  C.targetMismatch,
  C.released,
  C.poisoned,
  'feature_missing',
  'version_refused',
  'unsupported',
]);
/** How often a commit whose answer was lost is asked again, and how long it waits before each repeat. */
const COMMIT_ATTEMPTS = 3;
const COMMIT_BACKOFF_MS = 500;

/** @param {any} e a failure from the Host channel: a refusal that proves nothing was committed, or no answer at all */
const certainlyNot = (e) => DEFINITE.has(e?.code) || e?.notSent === true;
/** @param {unknown} n */
const isCount = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
const refusal = (/** @type {string} */ code, /** @type {string} */ message, /** @type {Record<string, unknown>} */ details = {}) =>
  new ContinueRefusal(code, message, details);

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./ownership.cjs').OwnershipStore>} o.ownership the side map: written only once a commit succeeded
 * @param {(hostId: string) => 'online' | 'connecting' | 'offline'} o.hostState the registry's answer for a Host (the local Host is always online)
 * @param {(hostId: string) => { call: (method: string, params: object) => Promise<any> }} o.channel the request channel to a Host, epoch and hello included; the seam 2.3 part 4b fills, a fake in tests. A failure may carry `code`, `details` and `notSent` (the request never left)
 * @param {(a: { chatId: string, sourceHostId: string, targetHostId: string }) => Promise<boolean>} o.confirmLostHost asks the user to continue without the source
 * @param {(chatId: string) => number} o.mirrorRev the last rev the app holds for the chat
 * @param {() => string} o.newKey mints an idempotency key
 * @param {(a: { chatId: string, hostId: string, fromRev: number }) => Promise<object[]>} o.fetchTail the returning source's items after `fromRev`, read only
 * @param {(a: { chatId: string, hostId: string, items: object[] }) => Promise<void> | void} o.mergeTail merges them into the chat as read-only history, by rev (a repeat changes nothing)
 * @param {(problem: string) => void} o.report where a problem that did not stop the continue is reported (main's ignored-error reporter)
 * @param {(ms: number) => Promise<void>} o.sleep waits between the repeats of a commit
 * @param {(hostId: string) => Promise<null | { code: string, message: string }>} [o.lostCheck] before the lost-host path: null, or why the source may still run (a cloud machine is lost only when its provider says it is gone)
 */
function createContinueMachine({
  ownership,
  hostState,
  channel,
  confirmLostHost,
  mirrorRev,
  newKey,
  fetchTail,
  mergeTail,
  report,
  sleep,
  lostCheck = async () => null,
}) {
  /** The one continue per chat running now. @type {Map<string, { phase: string, targetHostId: string, cancelled: boolean }>} */
  const active = new Map();
  /** A commit whose answer never came, or whose owner write failed: the chat may already be on the target. @type {Map<string, { source: string, target: string, expectedEpoch: number, preparedId: string, cwd: string, committed: { epoch: number } | null, landed?: boolean }>} */
  const unsettled = new Map();
  /** Hand-overs whose release did not reach the source: it is already read-only, so this only delays its cleanup. @type {Map<string, { hostId: string, chatId: string, epoch: number, preparedId: string }>} */
  const releases = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  const call = (/** @type {string} */ hostId, /** @type {string} */ method, /** @type {object} */ params) =>
    channel(hostId).call(method, params);

  /** The run is still the one that may go on: not cancelled, not disposed, and the chat's owner is where it started. @param {{ cancelled: boolean }} run @param {{ ownerHostId: string, epoch: number }} start @param {string} chatId */
  function stillMine(run, start, chatId) {
    if (disposed || run.cancelled) throw refusal(C.cancelled, 'The continue was cancelled; the chat stays where it was.');
    const now = ownership.get(chatId);
    if (now.ownerHostId !== start.ownerHostId || now.epoch !== start.epoch)
      throw refusal(C.ownerChanged, 'The chat moved while it was being continued; it stays where it is now.', {
        hostId: now.ownerHostId,
        epoch: now.epoch,
      });
  }

  /** Tells the target to drop a preparation; best effort (its own timer reclaims one that cannot be reached). */
  async function reclaim(
    /** @type {string} */ hostId,
    /** @type {string} */ chatId,
    /** @type {number} */ epoch,
    /** @type {string} */ preparedId,
  ) {
    try {
      await call(hostId, 'chat.release', { chatId, epoch, preparedId });
    } catch (e) {
      report(`Host ${hostId} did not reclaim a preparation: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** The target starts serving when told the new epoch; a miss costs nothing, the first request that carries it does the same. */
  async function activate(/** @type {string} */ hostId, /** @type {string} */ chatId, /** @type {number} */ epoch) {
    try {
      await call(hostId, 'chat.subscribe', { chatId, epoch });
      return true;
    } catch (e) {
      report(`Host ${hostId} was not told the new epoch yet: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  /** Release the source; a failure is kept to try again when it returns. */
  async function release(/** @type {{ hostId: string, chatId: string, epoch: number, preparedId: string }} r */ r) {
    try {
      await call(r.hostId, 'chat.release', { chatId: r.chatId, epoch: r.epoch, preparedId: r.preparedId });
      releases.delete(r.chatId);
      return true;
    } catch (e) {
      releases.set(r.chatId, r);
      report(`Host ${r.hostId} was not released yet: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  /** The new owner goes into the side map (the only write that moves a chat for the app). A map already at or past the epoch is what another window or an earlier try wrote. */
  function record(
    /** @type {string} */ chatId,
    /** @type {string} */ hostId,
    /** @type {number} */ epoch,
    /** @type {string | null} */ folder,
    /** @type {object} */ extra = {},
  ) {
    try {
      ownership.set(chatId, { hostId, ownerHostId: hostId, epoch, folder, ...extra });
    } catch (error) {
      // a map that already says this owner at this epoch (or has moved past it) is what an earlier try wrote; another owner at the same epoch is a conflict
      const now = ownership.get(chatId);
      if (now.epoch < epoch || (now.epoch === epoch && now.ownerHostId !== hostId)) throw error;
    }
  }

  /** What a commit answered: it must name this preparation and the next epoch, else it proves nothing. */
  const committedOk = (/** @type {any} */ res, /** @type {{ expectedEpoch: number, preparedId: string }} u */ u) =>
    res && isCount(res.epoch) && res.epoch === u.expectedEpoch + 1 && res.preparedId === u.preparedId;

  /** Asks the source to commit, again when the answer is lost. Returns the committed epoch; throws what certainly did not commit; an answer that never came leaves the continue unsettled. */
  async function commit(/** @type {string} */ chatId, /** @type {NonNullable<ReturnType<typeof unsettled.get>>} */ u) {
    let last;
    // an earlier try of this commit that was sent may have landed, whatever this one does
    let landed = u.landed === true;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(COMMIT_BACKOFF_MS * attempt);
      try {
        const res = await call(u.source, 'chat.commitContinue', {
          chatId,
          expectedEpoch: u.expectedEpoch,
          targetHostId: u.target,
          preparedId: u.preparedId,
        });
        if (committedOk(res, u)) return res.epoch;
        landed = true;
        last = new Error('The host answered the commit with something this app cannot read.');
      } catch (e) {
        // a request that never left proves nothing about an earlier one that did
        if (DEFINITE.has(/** @type {any} */ (e)?.code) || /** @type {any} */ (e?.notSent === true && !landed)) throw e;
        landed ||= /** @type {any} */ (e)?.notSent !== true;
        last = e;
      }
    }
    unsettled.set(chatId, { ...u, landed });
    throw refusal(C.commitUnsettled, 'The host did not confirm the move. The chat stays where it was until it does; try again.', {
      cause: String(/** @type {Error} */ (last)?.message ?? last),
    });
  }

  /** The commit is known: the map moves, the target is told, the source is released. @param {string} chatId @param {NonNullable<ReturnType<typeof unsettled.get>>} u @param {number} epoch */
  async function finish(chatId, u, epoch) {
    unsettled.set(chatId, { ...u, committed: { epoch } });
    record(chatId, u.target, epoch, u.cwd);
    unsettled.delete(chatId);
    const activated = await activate(u.target, chatId, epoch);
    const released = await release({ hostId: u.source, chatId, epoch, preparedId: u.preparedId });
    return { hostId: u.target, epoch, lostHost: false, activated, released };
  }

  /** A commit that could not be settled earlier is asked again before anything new starts for the chat. Resolves with what the chat is now, or null when nothing was open. */
  async function settleOpen(/** @type {string} */ chatId) {
    const u = unsettled.get(chatId);
    if (!u) return null;
    try {
      const epoch = u.committed ? u.committed.epoch : await commit(chatId, u);
      return await finish(chatId, u, epoch);
    } catch (e) {
      // an answer still owed from a source that is gone is the lost-host path's to settle, with the user's say
      const gone = /** @type {any} */ (e)?.code === C.commitUnsettled && hostState(u.source) === 'offline';
      if (!certainlyNot(e) && !gone) throw e;
      unsettled.delete(chatId);
      if (/** @type {any} */ (e).code === C.released) adopt(chatId, /** @type {any} */ (e).details);
      await reclaim(u.target, chatId, u.expectedEpoch + 1, u.preparedId);
      return null;
    }
  }

  /** The source says the chat is on `targetHostId` at `epoch`: the side map follows when that is newer than what it holds. @param {string} chatId @param {any} details */
  function adopt(chatId, details) {
    if (typeof details?.targetHostId !== 'string' || !isCount(details.epoch) || details.epoch <= ownership.get(chatId).epoch) return false;
    record(chatId, details.targetHostId, details.epoch, null);
    return true;
  }

  /** Closes the chat's lost-host record when it is the one `epoch` of `hostId` answered. @param {string} chatId @param {string} hostId @param {number} epoch */
  function closeLost(chatId, hostId, epoch) {
    const { lostHost, ...rest } = ownership.get(chatId);
    if (lostHost?.sourceHostId === hostId && lostHost.epoch === epoch) ownership.set(chatId, rest);
  }

  async function run(
    /** @type {string} */ chatId,
    /** @type {{ targetHostId: string, harness: string, cwd: string, handoff: string }} */ req,
    /** @type {{ phase: string, targetHostId: string, cancelled: boolean }} */ me,
  ) {
    const settled = await settleOpen(chatId);
    const start = ownership.get(chatId);
    if (settled && start.ownerHostId === req.targetHostId) return settled;
    const source = start.ownerHostId;
    if (source === req.targetHostId) throw refusal(C.sameHost, 'That chat already runs on this host.');
    if (hostState(req.targetHostId) !== 'online') throw refusal(C.targetOffline, 'That host is not online.');
    const epoch = start.epoch + 1;
    let lost = hostState(source) === 'offline';
    if (lost) {
      const blocked = await lostCheck(source);
      if (blocked) throw refusal(blocked.code, blocked.message);
      me.phase = 'confirming';
      changed();
      const yes = await confirmLostHost({ chatId, sourceHostId: source, targetHostId: req.targetHostId });
      if (!yes) throw refusal(C.lostHostDeclined, 'The chat stays where it was.');
      stillMine(me, start, chatId);
      // the source may have come back while the user read the card: then it commits the move itself
      lost = hostState(source) === 'offline';
    }
    me.phase = 'preparing';
    changed();
    const prepared = await call(req.targetHostId, 'chat.prepareContinue', {
      chatId,
      epoch,
      key: newKey(),
      harness: req.harness,
      cwd: req.cwd,
      handoff: req.handoff,
    });
    if (typeof prepared?.preparedId !== 'string' || typeof prepared?.cwd !== 'string')
      throw refusal(C.notPrepared, 'The host answered the preparation with something this app cannot read.');
    const u = {
      source,
      target: req.targetHostId,
      expectedEpoch: start.epoch,
      preparedId: prepared.preparedId,
      cwd: prepared.cwd,
      committed: null,
    };
    // once the commit is asked, only its answer says whether the preparation may be dropped
    let mayHaveCommitted = false;
    try {
      stillMine(me, start, chatId);
      if (lost) {
        // the one case in which the app advances the epoch itself; the source learns it from the next hello
        record(chatId, u.target, epoch, u.cwd, {
          lostHost: { sourceHostId: source, targetHostId: u.target, epoch, rev: mirrorRev(chatId) },
        });
        return { hostId: u.target, epoch, lostHost: true, activated: await activate(u.target, chatId, epoch), released: false };
      }
      me.phase = 'committing';
      changed();
      mayHaveCommitted = true;
      let committed;
      try {
        committed = await commit(chatId, u);
      } catch (e) {
        mayHaveCommitted = !certainlyNot(e);
        throw e;
      }
      return await finish(chatId, u, committed);
    } catch (e) {
      if (!mayHaveCommitted) {
        if (/** @type {any} */ (e)?.code === C.released) adopt(chatId, /** @type {any} */ (e).details);
        await reclaim(u.target, chatId, epoch, u.preparedId);
      }
      throw e;
    }
  }

  return {
    /**
     * Continues the chat on another Host. Resolves with where it is now; rejects with a ContinueRefusal (or the Host's own failure) and leaves the chat on its source.
     * @param {{ chatId: string, targetHostId: string, harness: string, cwd: string, handoff: string }} req
     */
    async continueChat(req) {
      if (disposed) throw refusal(C.cancelled, 'Continue is no longer available.');
      if (active.has(req.chatId)) throw refusal(C.inFlight, 'This chat is already being continued.');
      const me = { phase: 'starting', targetHostId: req.targetHostId, cancelled: false };
      active.set(req.chatId, me);
      changed();
      try {
        return await run(req.chatId, req, me);
      } finally {
        // a continue that replaced this one while it unwound keeps its own slot
        if (active.get(req.chatId) === me) active.delete(req.chatId);
        changed();
      }
    },

    /** Gives up before the owner changes; false once the commit is asked (its answer decides). @param {string} chatId */
    cancel(chatId) {
      const me = active.get(chatId);
      if (!me || me.phase === 'committing') return false;
      me.cancelled = true;
      return true;
    },

    /** What a window shows for the chat: the phase of the continue running, or null. @param {string} chatId */
    status(chatId) {
      const me = active.get(chatId);
      return me ? { phase: me.phase, targetHostId: me.targetHostId } : null;
    },

    /** The chats this app continued without `hostId`: its hello tells the Host, which then poisons its copy. @param {string} hostId */
    movedFrom: (hostId) => ownership.lostFrom(hostId),

    /**
     * The Host's answer to a hello that carried `movedFrom`: its poisoned copies' tails are read and merged as read-only history, and each chat's lost-host record is then closed (as are those the Host had already handed to the same host).
     * @param {string} hostId @param {any} reply `{ poisoned, conflicts, agreed }` from the Host
     */
    async sourceReturned(hostId, reply) {
      const list = (/** @type {unknown} */ v) =>
        Array.isArray(v) ? v.filter((x) => typeof x?.chatId === 'string' && isCount(x.epoch)) : null;
      const poisoned = list(reply?.poisoned);
      const conflicts = list(reply?.conflicts);
      const agreed = list(reply?.agreed ?? []);
      if (!poisoned || !conflicts || !agreed) return void report(`Host ${hostId} answered the hello with something this app cannot read.`);
      for (const c of conflicts)
        report(`Host ${hostId} handed ${c.chatId} to ${c.targetHostId} at the epoch this app moved it: two owners claim it.`);
      for (const a of agreed) closeLost(a.chatId, hostId, a.epoch);
      for (const p of poisoned) {
        const lost = ownership.get(p.chatId).lostHost;
        if (lost?.sourceHostId !== hostId || lost.epoch !== p.epoch) continue;
        try {
          await mergeTail({ chatId: p.chatId, hostId, items: await fetchTail({ chatId: p.chatId, hostId, fromRev: lost.rev }) });
          // the chat may have moved on while the tail was read: only the record this read answered is closed
          closeLost(p.chatId, hostId, p.epoch);
        } catch (e) {
          report(`The tail of ${p.chatId} from host ${hostId} was not merged yet: ${/** @type {Error} */ (e).message}`);
        }
      }
    },

    /** The source Host is back: the releases it missed are sent again. @param {string} hostId */
    async flushReleases(hostId) {
      for (const r of [...releases.values()]) if (r.hostId === hostId) await release(r);
    },

    adopt,

    /** @param {() => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    dispose() {
      disposed = true;
      for (const me of active.values()) me.cancelled = true;
      listeners.clear();
    },
  };
}

module.exports = { createContinueMachine };

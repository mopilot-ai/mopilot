// Moving MoMo's home to another machine (design 3.1, home lane S3): one Host's side of it, as ONE serialised state machine. Every step (begin, seal, cancel, expire, reclaim, finish on the old home; offer, receive, commit, discard on the new one) runs through a single queue per Host, and the rules (shared/host/momoMovePhases.mjs, pure) are applied INSIDE the write that re-reads the record, after every await, so two steps from two devices, a timer and a restart can interleave in any order and still never make two homes or lose the only one. The old home pauses, seals its files and data key to the target's one-time move key; the target checks the bundle without becoming the home; the switch gives it the next lease; after it the target's signed statement (the receipt of the switch, or the proof of a discard, never both for one move) is the only word that settles the outcome, and the old home deletes or resumes on it. A move that cannot be settled with the target is ended by the owner (`reclaim`): the old home runs again at a lease the target cannot hold. A client drives the steps (shared/momoMove.mjs); each is safe to send again with the same move id.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';
import { HOST_OWN } from './momoHome.mjs';
import { newMoveKey, sealBundle, openBundle, collectFiles, safeRel, receiptText, signReceipt, receiptOk } from './momoBundle.mjs';
import { createFileSafeStorage } from './secretStore.mjs';
import { MOVE_TTL_MS, MOVE_GRACE_MS, oldHome, target as targetRules } from '../../shared/host/momoMovePhases.mjs';

export { MOVE_TTL_MS, MOVE_GRACE_MS };
const require = createRequire(import.meta.url);
const { AuditLog } = require('../../electron/momo/audit.cjs');

/** What the Host keeps for itself in MoMo's folder and a move never carries: the grant, the home record, the chat registry, the newest lease seen, and files that are only locks or half-written. @param {string} rel */
export const stays = (rel) => HOST_OWN.includes(rel) || /\.(lock|tmp)$/.test(rel) || rel.startsWith('.');
/** A bundle over this size is refused, not cut (one wire frame is 8 MB, and a base64 bundle is a third larger than its files). */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** A refusal a rule returned, as the Host raises it. @param {{ error: { code: string, message: string, details?: object } }} r */
const raise = (r) => new HostRefusal(r.error.code, r.error.message, r.error.details);

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoHome.mjs').createMomoHome>} o.home
 */
export function createMomoMove({ home }) {
  const dir = home.storage.dir;
  const keyDir = home.data.keyDir;
  /** @param {string | null} d */
  const incomingOf = (d) => (d ? `${d}.incoming` : null);
  /**
   * The moves this process offered to take, by move id: a restart forgets them, so a move that was cut by one fails before the switch and
   * starts again. `phase` is the rules' (shared/host/momoMovePhases.mjs); what the switch answered is in the home record (receipts), not here.
   * @type {Map<string, { phase: 'offered' | 'received' | 'committed' | 'discarded', pub: { targetKey: string, signKey: string, fingerprint: string }, privateKey: import('node:crypto').KeyObject, signPrivate: import('node:crypto').KeyObject, expiresAt: number, received: { hash: string } | null }>}
   */
  const offers = new Map();
  /** The move whose files are in the stage folder: a step of another move does not touch them. @type {string | null} */
  let stageOwner = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** The one queue of this Host's move: a step starts when the one before it has ended, so no step reads a record another is about to change. */
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} step @returns {Promise<T>} */
  const queued = (step) => {
    const run = tail.then(step, step);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Delete a folder's contents and the folder. @param {string | null} d */
  const wipe = (d) => d && fs.rmSync(d, { recursive: true, force: true });
  /** Whether a folder holds anything MoMo's stores wrote: a machine that is no home must hold none. */
  const holdsData = () => fs.existsSync(dir) && collectFiles(dir, stays).length > 0;
  /** MoMo's files on this machine and its data key, deleted (a move that did not go through, or a copy that is no longer wanted). */
  const wipeData = () => {
    for (const f of collectFiles(dir, stays)) fs.rmSync(path.join(dir, f.path), { force: true });
    wipe(path.join(dir, 'audit'));
    wipe(keyDir);
    home.data.safeStorage.forget?.();
  };

  /**
   * One rule of the old home, applied to the record as it is when the write runs. A refusal is raised, a no-op or a resend changes nothing,
   * anything else is written (and the lease given when the rule gives one). @param {(r: any) => any} rule @returns {Promise<{ outcome: any, record: any }>}
   */
  const applyOld = async (rule) => {
    // read first: a step that changes nothing (a no-op, a resend, a refusal) writes nothing, so the record's watchers are not told of it
    const first = rule(/** @type {any} */ (home.record()));
    if (first.error) throw raise(first);
    if (!first.set) return { outcome: first, record: /** @type {any} */ (home.record()) };
    /** @type {any} */
    let outcome = first;
    await home.swap(/** @type {{ leaseEpoch: number }} */ (home.record()).leaseEpoch, (r) => {
      // and again inside the write, on the record as it is now: whatever happened since the read decides
      outcome = rule(r);
      if (outcome.error) throw raise(outcome);
      if (outcome.set) Object.assign(r, outcome.set);
      return outcome.set ? outcome.epoch : false;
    });
    return { outcome, record: /** @type {any} */ (home.record()) };
  };

  /** The old home resumes: its services start again. */
  const resumed = () => home.lifecycle('start');

  /**
   * A move that sealed nothing ends by itself once its time is out; one that sealed never does (the target may have switched before its own
   * deadline and the old home never heard), so it stays paused and says so until the target is asked or the owner reclaims. Runs in the queue.
   */
  const expireNow = async () => {
    const { outcome } = await applyOld((r) => oldHome.expire(r, { now: home.now() }));
    if (outcome.set) await resumed();
    return home.status();
  };
  /** @param {number} deadline */
  const watch = (deadline) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void queued(expireNow).catch(() => undefined), Math.max(0, deadline - home.now()) + 1000);
    timer.unref?.();
  };
  // a Host that restarted while moving: the record has the deadline, so the end of the move is still scheduled
  const restarted = home.record();
  if (restarted?.state === 'moving' && restarted.moveDeadline !== null) watch(restarted.moveDeadline);

  /** The receipt the record kept for a switch this machine made (after a restart, or a later move), or null. @param {string} moveId */
  const kept = (moveId) => home.record()?.moveReceipts[moveId] ?? null;

  return {
    /** Also what the timer runs. */
    expire: () => queued(expireNow),

    /** OLD HOME. Pause: from now on it takes no turns and opens no store, running turns are stopped and the turns in flight parked as interrupted. Sent again with the same move id it parks again and answers as it is. @param {{ moveId: string }} p */
    begin: ({ moveId }) =>
      queued(async () => {
        await expireNow();
        const { outcome, record } = await applyOld((r) => oldHome.begin(r, { moveId, now: home.now() }));
        if (outcome.set) {
          watch(record.moveDeadline);
          await home.lifecycle('pause');
        }
        // a turn the harness is still running would go on acting after the seal: it is stopped first, and parked again if this is a resend
        await home.stopTurns();
        await home.parkTurns();
        return home.status();
      }),

    /** OLD HOME. Seal: its files and its data key, closed to the target's move key; the key that checks the target's statements is kept with the record. A move seals once. @param {{ moveId: string, targetKey: string, signKey: string }} p */
    seal: ({ moveId, targetKey, signKey }) =>
      queued(async () => {
        // checked first, against the record as it is: a cancelled, expired or reclaimed move never yields a bundle
        const before = home.record();
        const early = oldHome.seal(/** @type {any} */ (before), { moveId, signKey, hash: '', now: home.now() });
        if ('error' in early) throw raise(early);
        // the stores let go of their files (the audit log's lock too); they open again only if the move is cancelled
        await home.close();
        const files = collectFiles(dir, stays);
        const keyFile = keyDir ? path.join(keyDir, 'safe-storage.key') : null;
        // the key is made on first use: a home that never sealed anything still has one to give
        if (!keyFile) throw new HostRefusal('move_unavailable', 'MoMo’s data on this machine is not kept with a key that can move.');
        home.data.safeStorage.encryptString('');
        const sealedBundle = sealBundle({ moveId, files, dataKey: fs.readFileSync(keyFile), targetKey });
        if (sealedBundle.sealed.length > MAX_BUNDLE_BYTES)
          throw new HostRefusal('bundle_too_large', 'MoMo’s data is too large to move in one piece yet.');
        // and again inside the write: the record must still be this move's, unsealed
        await applyOld((r) => oldHome.seal(r, { moveId, signKey, hash: sealedBundle.hash, now: home.now() }));
        return {
          sealed: sealedBundle.sealed,
          bundleHash: sealedBundle.hash,
          leaseEpoch: /** @type {any} */ (before).leaseEpoch,
          files: files.length,
        };
      }),

    /**
     * OLD HOME. Cancel, before the switch: it runs again at the same epoch. Before anything was sealed nothing left it, so any device may cancel.
     * After the seal the target might still switch, so it needs the target's signed word that it gave the move up (`proof`, from its `discard`);
     * without it the old home stays paused (and `reclaim` is the owner's way out). @param {{ moveId: string, proof?: string }} p
     */
    cancel: ({ moveId, proof }) =>
      queued(async () => {
        await expireNow();
        const h = home.record();
        const proofOk = !!h?.targetSignKey && receiptOk(h.targetSignKey, receiptText('discard', moveId), proof);
        const { outcome } = await applyOld((r) => oldHome.cancel(r, { moveId, proofOk: proofOk && r.targetSignKey === h?.targetSignKey }));
        if (outcome.set) await resumed();
        return home.status();
      }),

    /**
     * OLD HOME. The owner's own decision for a target that is gone or disagrees (an explicit action of an authenticated device): MoMo runs
     * here again at a lease two ahead, which the target (one ahead) could not hold, so if it ever returns, whatever it stamps is older than
     * this home's and every receiver refuses it. The copy on the target is the owner's to delete. The app asks the target first and goes on only when it
     * cannot be reached or says it holds nothing of the move (never when it switched: then the owner finishes the move). @param {{ moveId: string, by?: string | null }} p
     */
    reclaim: ({ moveId, by }) =>
      queued(async () => {
        // an explicit act of an authenticated device (the wire handler names the caller), never a flag a request can carry on its own
        if (!by) throw new HostRefusal('reclaim_not_owner', 'Only a paired device can decide that MoMo runs here again.');
        // the copy is what the owner reclaims: with none here, an empty home at a higher lease would fence out the target's good one
        if (!holdsData())
          throw new HostRefusal('home_copy_missing', 'MoMo’s copy is no longer on this machine, so it cannot run here again.');
        const { outcome } = await applyOld((r) => oldHome.reclaim(r, { moveId }));
        if (outcome.set) await resumed();
        return home.status();
      }),

    /**
     * OLD HOME. The switch happened (the target runs at `leaseEpoch`): delete the copy and the key, keep a tombstone at the new epoch, so
     * nothing here acts again. It deletes only on the target's signed receipt for exactly this move, epoch, machine and bundle. Sent again
     * once it is done, it answers as it is. @param {{ moveId: string, leaseEpoch: number, name: string, homeId: string, receipt: string }} p
     */
    finish: ({ moveId, leaseEpoch, name, homeId, receipt }) =>
      queued(async () => {
        const h = home.record();
        const okReceipt =
          !!h?.targetSignKey &&
          !!h.bundleHash &&
          receiptOk(h.targetSignKey, receiptText('commit', moveId, String(leaseEpoch), homeId, h.bundleHash), receipt);
        const { outcome } = await applyOld((r) => oldHome.finish(r, { moveId, leaseEpoch, receiptOk: okReceipt }));
        if (outcome.noop) {
          // finished already; a copy a cut-short finish left behind (the tombstone is written first) goes now
          if (holdsData()) {
            await home.close();
            wipeData();
          }
          return home.status();
        }
        // the tombstone first: a crash after it leaves a machine that is no home with a copy a repeated finish deletes, never a moving home with no data
        await home.tombstone({ name, homeId, leaseEpoch });
        if (timer) clearTimeout(timer);
        await home.lifecycle('wipe');
        await home.close();
        wipeData();
        return home.status();
      }),

    /** NEW HOME. A one-time move key for this move (with the key that signs its statements) and a fingerprint of both for the person to see beside the machine's name. A machine that is no home holds no MoMo data: what a cut-short switch left is cleared. Made before the old home pauses, so its deadline is the earlier one. Sent again, the same offer. @param {{ moveId: string }} p */
    offer: ({ moveId }) =>
      queued(async () => {
        const h = home.record();
        if (!h) throw new HostRefusal('home_unavailable', 'MoMo’s home record on this machine cannot be read.');
        const t = offers.get(moveId);
        const rule = targetRules.offer(t && { phase: t.phase, expiresAt: t.expiresAt }, { homeState: h.state, now: home.now() });
        if ('error' in rule) throw h.state !== 'none' ? new HostRefusal('home_exists', `MoMo's home is ${h.name}.`) : raise(rule);
        if (t && 'phase' in rule && rule.phase === t.phase) return { moveId, ...t.pub };
        if (holdsData()) wipeData();
        // one stage folder is one move's: another offer replaces the earlier one, which is given up
        for (const [id, o] of offers) if (id !== moveId && o.phase !== 'committed') o.phase = 'discarded';
        wipe(incomingOf(dir));
        wipe(incomingOf(keyDir));
        stageOwner = null;
        const key = newMoveKey();
        const pub = { targetKey: key.publicKey, signKey: key.signKey, fingerprint: key.fingerprint };
        offers.set(moveId, {
          phase: 'offered',
          pub,
          privateKey: key.privateKey,
          signPrivate: key.signPrivate,
          expiresAt: home.now() + MOVE_TTL_MS,
          received: null,
        });
        return { moveId, ...pub };
      }),

    /** NEW HOME. Receive: open the bundle, check its hash and its audit chain, and keep it aside, not yet the home. @param {{ moveId: string, sealed: string, bundleHash: string }} p */
    receive: ({ moveId, sealed, bundleHash }) =>
      queued(async () => {
        const offer = offers.get(moveId);
        const rule = targetRules.receive(offer && { phase: offer.phase, expiresAt: offer.expiresAt }, { now: home.now() });
        if ('error' in rule) throw raise(rule);
        const mine = /** @type {NonNullable<typeof offer>} */ (offer);
        /** @type {ReturnType<typeof openBundle>} */
        let opened;
        try {
          opened = openBundle({ moveId, sealed, privateKey: mine.privateKey });
        } catch {
          throw new HostRefusal('bundle_unreadable', 'The bundle could not be opened here, so nothing was changed.');
        }
        if (opened.hash !== bundleHash)
          throw new HostRefusal('bundle_mismatch', 'The bundle is not the one that was sealed, so nothing was changed.');
        if (opened.files.some((f) => !safeRel(f.path)))
          throw new HostRefusal('bundle_unreadable', 'The bundle names a place outside MoMo’s folder.');
        const stage = /** @type {string} */ (incomingOf(dir));
        const stageKeys = /** @type {string} */ (incomingOf(keyDir));
        wipe(stage);
        wipe(stageKeys);
        for (const f of opened.files) {
          fs.mkdirSync(path.dirname(path.join(stage, f.path)), { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(stage, f.path), f.data, { mode: 0o600 });
        }
        fs.mkdirSync(stageKeys, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(stageKeys, 'safe-storage.key'), opened.dataKey, { mode: 0o600 });
        // the chain must run on, with the key that came with it, before this machine may become the home
        if (fs.existsSync(path.join(stage, 'audit'))) {
          const log = new AuditLog({ dir: path.join(stage, 'audit'), safeStorage: createFileSafeStorage(stageKeys) });
          const verdict = await log.verify().finally(() => log.close());
          if (!verdict.ok) {
            wipe(stage);
            wipe(stageKeys);
            throw new HostRefusal('audit_chain_broken', 'MoMo’s audit log did not check out on this machine, so nothing was changed.');
          }
        }
        stageOwner = moveId;
        mine.phase = 'received';
        mine.received = { hash: opened.hash };
        return { received: true, bundleHash: opened.hash, files: opened.files.length };
      }),

    /**
     * NEW HOME. The switch: what was received becomes MoMo's folder and key, and this machine is the home at `leaseEpoch`, the lease after the
     * old home's. Everything that can refuse is checked before a file moves and again just before the record is written (a discard cannot slip
     * in: it is queued behind this); anything that goes wrong after files were put in place deletes them at once. The answer carries the target's
     * signed receipt, which is also kept in the record, so it is told again after a restart or a later move. @param {{ moveId: string, leaseEpoch: number, name: string, from: string }} p
     */
    commit: ({ moveId, leaseEpoch, name, from }) =>
      queued(async () => {
        const homeId = home.hostId;
        // the switch is in the record: a repeat (after a restart, or after a later move) answers the same, with the receipt it kept
        const had = kept(moveId);
        if (had) {
          if (had.leaseEpoch !== leaseEpoch) throw new HostRefusal('home_lease_stale', 'That move already switched at another lease.');
          return { ...home.status(), receipt: had.receipt, homeId };
        }
        const offer = offers.get(moveId);
        const now = home.now();
        const rule = targetRules.commit(offer && { phase: offer.phase, expiresAt: offer.expiresAt }, {
          now,
          stageOwned: stageOwner === moveId,
        });
        if ('error' in rule) throw raise(rule);
        const mine = /** @type {NonNullable<typeof offer>} */ (offer);
        const hash = /** @type {{ hash: string }} */ (mine.received).hash;
        home.canAdopt(leaseEpoch);
        const stage = /** @type {string} */ (incomingOf(dir));
        const stageKeys = /** @type {string} */ (incomingOf(keyDir));
        const receipt = signReceipt(mine.signPrivate, receiptText('commit', moveId, String(leaseEpoch), homeId, hash));
        // the "it moved" entry goes into the staged audit log first (intent, then outcome), so a machine killed after the switch has it
        const log = new AuditLog({ dir: path.join(stage, 'audit'), safeStorage: createFileSafeStorage(stageKeys) });
        try {
          const { id } = await log.intent({
            action: 'momo.home.moved',
            chatId: 'momo-home',
            decision: 'allowed',
            args: { from, to: name, leaseEpoch },
          });
          await log.outcome(id, { result: 'done', note: `moved from ${from}` });
        } finally {
          await log.close();
        }
        // after the awaits: the offer must still be this one's, received and not given up
        const again = targetRules.commit(
          { phase: mine.phase, expiresAt: mine.expiresAt },
          { now: home.now(), stageOwned: stageOwner === moveId },
        );
        if ('error' in again) throw raise(again);
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          for (const f of collectFiles(stage, () => false)) {
            fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true, mode: 0o700 });
            fs.renameSync(path.join(stage, f.path), path.join(dir, f.path));
          }
          fs.mkdirSync(/** @type {string} */ (keyDir), { recursive: true, mode: 0o700 });
          fs.renameSync(path.join(stageKeys, 'safe-storage.key'), path.join(/** @type {string} */ (keyDir), 'safe-storage.key'));
          wipe(stage);
          wipe(stageKeys);
          stageOwner = null;
          home.data.safeStorage.forget?.();
          await home.adopt({ homeId, name, leaseEpoch, bundleHash: hash, moveId, receipt });
        } catch (error) {
          // whatever was put in place goes again at once: a switch that did not happen leaves no MoMo data, no key and no stage behind
          wipeData();
          wipe(stage);
          wipe(stageKeys);
          if (stageOwner === moveId) stageOwner = null;
          throw error;
        }
        mine.phase = 'committed';
        return { ...home.status(), receipt, homeId };
      }),

    /**
     * NEW HOME. A move that did not go through: what was offered and received is deleted and the move id is tombstoned, so a bundle or a switch
     * that arrives late is refused for good. The answer is signed, which is what lets the old home resume. A switch that already happened (told
     * from the record, so also after a restart or a later move) is answered as it is, with its receipt, never undone. Queued behind a commit,
     * so exactly one of the receipt and the discard is ever signed for a move. @param {{ moveId: string }} p
     */
    discard: ({ moveId }) =>
      queued(async () => {
        const had = kept(moveId);
        if (had) return { committed: true, leaseEpoch: had.leaseEpoch, receipt: had.receipt, homeId: home.hostId };
        const offer = offers.get(moveId);
        const rule = targetRules.discard(offer && { phase: offer.phase, expiresAt: offer.expiresAt });
        if ('answer' in rule) {
          // switched, but the record no longer holds its receipt: the switch is told, the receipt cannot be
          return { committed: true, leaseEpoch: 0, receipt: '', homeId: home.hostId };
        }
        // only the stage this move owns is deleted: a late discard of an earlier move leaves the current move's copy alone
        if (stageOwner === moveId || stageOwner === null) {
          wipe(incomingOf(dir));
          wipe(incomingOf(keyDir));
          stageOwner = null;
        }
        if (!offer) {
          // nothing was offered here (or this Host restarted since): nothing can be committed for it, and it cannot sign
          return { discarded: true, proof: null };
        }
        offer.phase = 'discarded';
        return { discarded: true, proof: signReceipt(offer.signPrivate, receiptText('discard', moveId)) };
      }),
  };
}

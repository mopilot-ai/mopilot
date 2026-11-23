// The turn ledger of MoMo's home (design 1, "Always there"): one sealed record per message a device sends, written as `accepted` before anything acts, so after a lost connection the device asks the turn's status instead of sending again, and delivery is never repeated on an uncertain answer. Written from the design's description (the idea is nanoMuse's, GPL, so no code is taken).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** The ledger keeps this many settled turns; a turn still `accepted` is never dropped. */
export const KEEP_SETTLED = 500;
/** @typedef {'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted'} TurnState */
/** @typedef {{ turnId: string, chatId: string, deviceId: string | null, state: TurnState, acceptedAt: number, settledAt: number | null, leaseEpoch: number, resultRef: string | null }} Turn */

/** How many ids of pruned turns the ledger remembers (with the state each ended in): a resend of one of them is the same turn, never a new one. */
export const KEEP_GONE = 5000;
/** @typedef {Exclude<TurnState, 'accepted'>} Settled */

/** @param {any} v @returns {{ turns: Record<string, Turn>, gone: Record<string, Settled> }} */
const shape = (v) => {
  /** @type {Record<string, Turn>} */
  const turns = {};
  for (const [id, t] of Object.entries(v?.turns ?? {})) {
    const x = /** @type {any} */ (t);
    if (typeof x?.chatId !== 'string' || !['accepted', 'completed', 'failed', 'cancelled', 'interrupted'].includes(x.state)) continue;
    turns[id] = {
      turnId: id,
      chatId: x.chatId,
      deviceId: typeof x.deviceId === 'string' ? x.deviceId : null,
      state: x.state,
      acceptedAt: Number.isFinite(x.acceptedAt) ? x.acceptedAt : 0,
      settledAt: Number.isFinite(x.settledAt) ? x.settledAt : null,
      leaseEpoch: Number.isSafeInteger(x.leaseEpoch) ? x.leaseEpoch : 0,
      resultRef: typeof x.resultRef === 'string' ? x.resultRef : null,
    };
  }
  /** @type {Record<string, Settled>} */
  const gone = {};
  for (const [id, state] of Object.entries(v?.gone ?? {}))
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(/** @type {string} */ (state)))
      gone[id] = /** @type {Settled} */ (state);
  return { turns, gone };
};

/**
 * How a turn's end frame settles it: a person's Stop or a harness that gave up reads `cancelled`, a restart's end names what was cut
 * off (`interrupted`), an error reads `failed`, anything else `completed`.
 * @param {any} end the `turnEnd` event
 * @returns {Exclude<TurnState, 'accepted'>}
 */
export function settledAs(end) {
  if (end?.interrupted) return 'interrupted';
  if (end?.stopReason === 'cancelled') return 'cancelled';
  return end?.error ? 'failed' : 'completed';
}

/**
 * @param {object} o
 * @param {string} o.dir MoMo's folder on this Host
 * @param {import('../../electron/platform/secretFile.cjs').SafeStorage} o.safeStorage
 * @param {() => number} o.now
 * @param {number} [o.keep] how many settled turns are kept
 * @param {number} [o.keepGone] how many ids of pruned turns are kept
 */
export function createMomoTurns({ dir, safeStorage, now, keep = KEEP_SETTLED, keepGone = KEEP_GONE }) {
  const file = new SealedJson({ file: path.join(dir, 'turns.json'), safeStorage, shape, now });
  const read = () => (fs.existsSync(path.join(dir, 'turns.json')) ? file.read() : shape(null));
  /** When this process opened the ledger: a turn accepted before it was cut off by the restart. */
  const openedAt = now();
  /** @param {(t: Turn) => boolean} which the accepted turns to end @returns {Promise<number>} how many ended */
  const interrupt = async (which) => {
    if (!fs.existsSync(path.join(dir, 'turns.json'))) return 0;
    let n = 0;
    await file.change((all) => {
      for (const t of Object.values(all.turns))
        if (t.state === 'accepted' && which(t)) Object.assign(t, { state: 'interrupted', settledAt: now() }), n++;
    });
    return n;
  };
  return {
    /**
     * A device's message is accepted before anything acts on it. The same turn id again (a resend after a lost answer) is the same turn,
     * never a second run; a turn id used for another chat is a mistake and is refused; a second turn while one of the chat is unsettled
     * is `busy`.
     * @param {{ turnId: string, chatId: string, deviceId: string | null, leaseEpoch: number }} t
     * @returns {Promise<{ duplicate: boolean, turn: Turn }>}
     */
    async accept({ turnId, chatId, deviceId, leaseEpoch }) {
      /** @type {{ duplicate: boolean, turn: Turn } | null} */
      let out = null;
      await file.change((all) => {
        // a turn pruned from the ledger is still the same turn: its id is kept (with its end) past the pruning window, so a late resend never runs again
        if (!all.turns[turnId] && all.gone[turnId]) {
          out = {
            duplicate: true,
            turn: { turnId, chatId, deviceId, state: all.gone[turnId], acceptedAt: 0, settledAt: null, leaseEpoch, resultRef: null },
          };
          return;
        }
        const seen = all.turns[turnId];
        if (seen) {
          if (seen.chatId !== chatId) throw new HostRefusal('turn_conflict', 'That turn belongs to another chat.');
          out = { duplicate: true, turn: seen };
          return;
        }
        if (Object.values(all.turns).some((x) => x.chatId === chatId && x.state === 'accepted'))
          throw new HostRefusal('turn_busy', 'MoMo is still working on your last message.');
        const turn = {
          turnId,
          chatId,
          deviceId,
          state: /** @type {const} */ ('accepted'),
          acceptedAt: now(),
          settledAt: null,
          leaseEpoch,
          resultRef: null,
        };
        all.turns[turnId] = turn;
        const settled = Object.values(all.turns).filter((x) => x.state !== 'accepted');
        for (const old of settled
          .sort((a, b) => /** @type {number} */ (a.settledAt) - /** @type {number} */ (b.settledAt))
          .slice(0, Math.max(0, settled.length - keep)))
          (all.gone[old.turnId] = /** @type {Settled} */ (old.state)), delete all.turns[old.turnId];
        const ids = Object.keys(all.gone);
        for (const id of ids.slice(0, Math.max(0, ids.length - keepGone))) delete all.gone[id];
        out = { duplicate: false, turn };
      });
      return /** @type {any} */ (out);
    },
    /**
     * The chat's one unsettled turn ends. Nothing happens when it has none (a coding chat, a turn from before the ledger).
     * @param {string} chatId @param {Exclude<TurnState, 'accepted'>} state @param {string | null} [resultRef]
     */
    async settle(chatId, state, resultRef = null) {
      if (!fs.existsSync(path.join(dir, 'turns.json'))) return;
      await file.change((all) => {
        const turn = Object.values(all.turns).find((x) => x.chatId === chatId && x.state === 'accepted');
        if (turn) Object.assign(turn, { state, settledAt: now(), resultRef });
      });
    },
    /** What the device asks after a reconnect: the turn as kept, or `unknown` for one this home never saw (never sent, so safe to send). @param {string} turnId */
    status(turnId) {
      const all = read();
      const turn = all.turns[turnId];
      if (turn) return turn;
      return all.gone[turnId] ? { turnId, state: all.gone[turnId] } : { turnId, state: /** @type {const} */ ('unknown') };
    },
    /** Every turn id the ledger holds, for a Reset to keep as void. */
    ids: () => {
      const all = read();
      return [...Object.keys(all.turns), ...Object.keys(all.gone)];
    },
    /** A Host that restarted found turns it had accepted and never ended: they did not finish, and nothing sends them again. */
    recover: () => interrupt((t) => t.acceptedAt < openedAt),
    /** A move parks the turns in flight as interrupted: they are never replayed on the new home without asking. */
    interruptOpen: () => interrupt(() => true),
  };
}

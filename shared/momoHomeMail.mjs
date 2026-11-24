// The messages this device sends to MoMo's home (shared/momoHomeReal.mjs): kept in the outbox before they go, held while the home sleeps and sent in order when it is back under their own ids, shown in the chat with how far each got (the ones already sent are kept sealed too, with the home they were sent to, so they are still there after a restart and never shown in a chat that home never had), and never sent blindly again after a doubt. A message a Host refuses for good, one that waited more than a day and one written for a home that no longer exists are kept and shown as not sent, with a way to send it to this MoMo or delete it: nothing is dropped silently. A storage problem is told on its own and never turns a message the Host took into one that failed.
import { fixId } from './momoFixId.mjs';
import { IntentError } from './momoHomeApi.mjs';
import { deliveryOf } from './momoHomeView.mjs';
import { mayHaveArrived } from './momoHomeLook.mjs';
import { prefixCodePoints } from './textPrefix.mjs';

/** The messages waiting for a home that sleeps: more than this and a new one is refused, with the reason. */
export const OUTBOX_MAX = 50;
/** How many sent messages stay in the chat after the outbox lets go of them. */
const SENT_MAX = 100;
/** A message that waited longer than this is not sent late; it stays, shown as not sent, until the person decides. */
export const HELD_MAX_AGE_MS = 24 * 3_600_000;
/** After the Host says its chat still has a turn open, the next try waits this long, then twice as long, up to the cap. */
const BUSY_WAIT_MS = 30_000;
const BUSY_CAP_MS = 5 * 60_000;
/** Refusals that pass: the home is moving or away, its chat is busy, or its grant lapsed (it is sent again). Any other refusal is for good, until the person acts. */
const PASSING = new Set(['turn_busy', 'momo_home_away', 'momo_grant_lapsed']);

/** A Host's refusal in the person's words: its own message, or a line of ours when it said none. @param {unknown} error @param {string} fallback */
const wordsOf = (error, fallback) => {
  const m = /** @type {any} */ (error)?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : fallback;
};

/**
 * @typedef {{ id: string, text: string, at: number, homeId?: string }} SentEntry
 * @param {object} o
 * @param {ReturnType<typeof import('./momoOutbox.mjs').createMomoOutbox>} o.outbox
 * @param {{ read: () => SentEntry[], write: (list: SentEntry[]) => void }} o.sent where the messages already sent are kept (sealed, per account)
 * @param {() => number} o.now
 * @param {(machine: { id: string }, params: { chatId: string, epoch: number, text: string, key: string }) => Promise<unknown>} o.send one `chat.send` to the home, within its time
 * @param {(machine: any) => Promise<{ chatId: string, epoch: number }>} o.chatOn the chat MoMo's turns go to on that machine
 * @param {(error: unknown) => void} o.report
 * @param {() => boolean} o.alive false once the home service is stopped: nothing more is sent or written
 * @param {() => number} o.epoch counted up when what was kept is forgotten: an operation that began before writes nothing
 * @param {() => string[]} o.lineage the homes MoMo has lived on (the current one included): messages are shown and sent only for these
 */
export function createMail({ outbox, sent, now, send, chatOn, report, alive, epoch, lineage }) {
  /** Messages this device sent and the home has them: the chat keeps showing how far each got. @type {Map<string, { text: string, at: number, homeId?: string }>} */
  const sentLog = new Map(sent.read().map((m) => [m.id, { text: m.text, at: m.at, homeId: m.homeId }]));
  /** What the home said of a turn when asked (`check-turn`): the ledger state, or `unknown` for one it never saw. @type {Map<string, string>} */
  const ledgers = new Map();
  let flushing = false;
  let busyUntil = 0;
  let busyFails = 0;
  /** What is wrong with where this Mac keeps the messages, in words, or null. @type {string | null} */
  let storage = null;

  /** A write to the Mac's own storage that may fail (no system key, a file that cannot be read): told as a problem of its own, never as the message failing. @param {() => void} fn */
  const keep = (fn) => {
    try {
      fn();
      storage = null;
      return true;
    } catch (error) {
      storage = wordsOf(error, 'MoMo can’t keep your messages on this Mac right now.');
      report(error);
      return false;
    }
  };
  /** @param {string} turnId @param {string} text @param {number} at @param {string} [homeId] */
  const remember = (turnId, text, at, homeId) => {
    sentLog.set(turnId, { text, at, homeId });
    if (sentLog.size > SENT_MAX) sentLog.delete(/** @type {string} */ (sentLog.keys().next().value));
    keep(() => sent.write([...sentLog.entries()].map(([id, m]) => ({ id, text: m.text, at: m.at, homeId: m.homeId }))));
  };
  /** The homes a message may belong to; none known yet means every message does. */
  const known = () => lineage().filter(Boolean);
  /** Written for a home that no longer exists (MoMo was started again, or an older copy was used). @param {{ homeId?: string }} e */
  const orphaned = (e) => !!e.homeId && known().length > 0 && !known().includes(e.homeId);
  /** Waited so long it is not sent late. @param {{ delivery: string, createdAt: number, renewedAt?: number }} e */
  const tooOld = (e) => e.delivery === 'not-sent' && now() - (e.renewedAt ?? e.createdAt) > HELD_MAX_AGE_MS;
  /** Why a held message is not sent, in words, or null while it waits to go. @param {any} e */
  const notSent = (e) =>
    e.refusal ??
    (orphaned(e)
      ? 'MoMo was started again, and this was written for the old one.'
      : tooOld(e)
        ? 'It waited more than a day, so it was not sent late.'
        : null);

  /** Only a message that was not sent (refused, too old, or written for another home) may be tried again or deleted: not one that is waiting its turn, on its way, or already with the home. @param {string} turnId */
  const waitingNotSent = (turnId) => {
    const e = outbox.all().find((x) => x.turnId === turnId);
    if (!e || e.delivery !== 'not-sent' || !notSent(e)) throw new IntentError('That message is not waiting any more.');
    if (flushing) throw new IntentError('MoMo is sending messages right now. Try again in a moment.');
  };
  /**
   * One message to the home's chat. A Host that answers "no" took nothing; a call that may have reached it leaves the message "not sure".
   * What happens to the outbox and the sent log afterwards is the Mac's own storage: it never changes what the Host took.
   * @param {string} turnId @param {string} text @param {any} machine @param {{ homeId?: string, kept?: boolean, chat?: { chatId: string, epoch: number } }} [how]
   */
  async function deliver(turnId, text, machine, { homeId, kept = true, chat: given } = {}) {
    const g = epoch();
    const chat = given ?? (await chatOn(machine));
    if (kept) keep(() => outbox.sending(turnId));
    try {
      await send(machine, { ...chat, text, key: turnId });
    } catch (error) {
      if (g !== epoch() || !alive()) throw new IntentError('MoMo is not here any more.');
      if (mayHaveArrived(error)) throw new IntentError('Not sure MoMo got that message. Check before sending it again.');
      const code = /** @type {any} */ (error)?.code;
      const why = wordsOf(error, 'MoMo could not take that message.');
      if (kept) keep(() => (PASSING.has(code) ? outbox.neverArrived(turnId) : outbox.refuse(turnId, why)));
      // a chat with a turn open, a home that is moving or away, a grant that lapsed (the next look sends it again): each is asked again later, not at once
      if (PASSING.has(code)) {
        busyFails++;
        busyUntil = now() + Math.min(BUSY_CAP_MS, BUSY_WAIT_MS * 2 ** (busyFails - 1));
      }
      throw Object.assign(new IntentError(why), { refusal: code, forever: !PASSING.has(code) });
    }
    busyFails = 0;
    // the Host has it: what is written about it afterwards is only the Mac's own record, and a Reset or another account in between writes nothing
    if (g !== epoch() || !alive()) return;
    if (kept) keep(() => outbox.settle(turnId));
    remember(turnId, text, now(), homeId);
  }

  return {
    deliver,
    /** The user rows of the chat: each message this device sent, with how far it got; one that is not sent (refused, too old, for another home) says so. */
    rows() {
      const here = new Set(known());
      const waiting = outbox.all().map((e) => ({
        kind: /** @type {const} */ ('user'),
        id: e.turnId,
        at: e.createdAt,
        text: e.text,
        delivery: notSent(e)
          ? /** @type {const} */ ('failed')
          : deliveryOf({ outbox: e.delivery, ledger: /** @type {any} */ (ledgers.get(e.turnId) ?? null) }),
      }));
      const held = new Set(waiting.map((r) => r.id));
      const done = [...sentLog.entries()]
        .filter(([id, s]) => !held.has(id) && (!s.homeId || here.size === 0 || here.has(s.homeId)))
        .map(([id, s]) => ({
          kind: /** @type {const} */ ('user'),
          id,
          at: s.at,
          text: s.text,
          delivery: deliveryOf({ outbox: 'sent-uncertain', ledger: /** @type {any} */ (ledgers.get(id) ?? 'accepted') }),
        }));
      return [...done, ...waiting];
    },
    /** A "waiting for <machine>" row while MoMo sleeps and a message waits for it. @param {boolean} asleep @param {{ machineId: string | null, name: string } | null} where */
    waitingRow(asleep, where) {
      const all = outbox.all().filter((e) => !notSent(e));
      if (!asleep || !all.length || !where?.machineId) return [];
      return [
        {
          kind: /** @type {const} */ ('waiting'),
          id: 'waiting',
          at: Math.min(...all.map((e) => e.createdAt)),
          machine: { machineId: where.machineId, name: where.name },
        },
      ];
    },
    /** What the view says of the messages that were not sent and of the Mac's own storage, each with the way out: send it to this MoMo, or delete it. */
    problems() {
      /** @type {any[]} */
      const out = [];
      if (storage)
        out.push({
          id: 'storage',
          code: 'storage',
          cause: `${storage} Messages can’t be kept until that is fixed.`,
          fix: { id: 'check-again', label: 'Check again' },
          since: null,
        });
      for (const e of outbox.all()) {
        const why = notSent(e);
        if (!why) continue;
        const short = prefixCodePoints(e.text, 40);
        const what = short === e.text ? e.text : `${short}…`;
        out.push(
          {
            id: `send:${e.turnId}`,
            code: 'send_refused',
            cause: `Not sent: “${what}”. ${why}`,
            fix: { id: fixId('retry-send', e.turnId), label: orphaned(e) ? 'Send to this MoMo' : 'Try again' },
            since: e.createdAt,
          },
          {
            id: `drop:${e.turnId}`,
            code: 'send_refused',
            cause: `Or delete “${what}”.`,
            fix: { id: fixId('delete-send', e.turnId), label: 'Delete message' },
            since: e.createdAt,
          },
        );
      }
      return out;
    },
    /** The person asks again for a message that was not sent: it is made ready for the home MoMo has now, keeps its place, and goes with the next look. @param {string} turnId @param {string} homeId */
    retry(turnId, homeId) {
      waitingNotSent(turnId);
      busyUntil = 0;
      if (!keep(() => outbox.renew(turnId, homeId))) throw new IntentError(`${storage}`);
    },
    /** The person deletes a message that was not sent. @param {string} turnId */
    discard(turnId) {
      waitingNotSent(turnId);
      if (!keep(() => outbox.settle(turnId))) throw new IntentError(`${storage}`);
    },
    /**
     * Takes the message: sent now to the home that runs, or held (with the home it was written for) while MoMo sleeps. The home said it never got this
     * one: it goes again under the same id, because the person said so. A Host that refuses a message just written does not keep it: the person has the text.
     * When this Mac cannot keep it (no system key) it is still sent to a home that runs; it cannot be held for one that sleeps, and the person is told why.
     * @param {{ turnId: string, text: string, home: any | null, homeId: string }} m
     */
    async take({ turnId, text, home, homeId }) {
      const g = epoch();
      const held = outbox.all().find((e) => e.turnId === turnId);
      if (held && ledgers.get(turnId) === 'unknown') {
        outbox.neverArrived(turnId);
        ledgers.delete(turnId);
      }
      if (!held && outbox.all().length >= OUTBOX_MAX)
        throw new IntentError(`${OUTBOX_MAX} messages are already waiting for MoMo. Wait until it is back.`);
      if (!home) {
        if (!keep(() => outbox.save({ turnId, chatId: '', text, homeId })))
          throw new IntentError(`${storage} A message can’t wait for MoMo until that is fixed.`);
        return;
      }
      const chat = await chatOn(home.machine);
      if (g !== epoch() || !alive()) throw new IntentError('MoMo is not here any more.');
      const stored = held ? true : keep(() => outbox.save({ turnId, chatId: chat.chatId, text, homeId }));
      try {
        await deliver(turnId, text, home.machine, { homeId, kept: stored, chat });
      } catch (error) {
        // the composer keeps the text, so a message refused as it was written is not also kept here
        if (!held && stored && /** @type {any} */ (error)?.refusal) keep(() => outbox.settle(turnId));
        throw error;
      }
    },
    /** What the home said of a message: it has it (settled), never saw it (the person may send it again), or cannot say (nothing is sent blindly). @param {string} turnId @param {'has' | 'missing' | 'unknown'} turn @param {string} ledger @param {string} [homeId] */
    checked(turnId, turn, ledger, homeId) {
      if (turn === 'has') {
        const held = outbox.all().find((e) => e.turnId === turnId);
        if (held) remember(turnId, held.text, held.createdAt, homeId);
        keep(() => outbox.settle(turnId));
        ledgers.set(turnId, ledger);
      } else if (turn === 'missing') ledgers.set(turnId, 'unknown');
    },
    /** Goes through the Host's chat for each held message that can go now, oldest first, in order and under its own id (the home accepts one copy). @param {any} home */
    async flush(home) {
      if (flushing || !outbox || !home || home.status.home.state !== 'running' || now() < busyUntil) return;
      flushing = true;
      try {
        // each turn: what may go now is looked at again, so held messages of one chat go one after the other, in order
        while (alive()) {
          const e = outbox.due().find((x) => !notSent(x));
          if (!e) break;
          try {
            await deliver(e.turnId, e.text, home.machine, { homeId: home.status.home.homeId });
          } catch (error) {
            // one the Host refused for good does not hold up the ones behind it; one that waits (its chat has a turn open, the home is moving) does
            if (!(error instanceof IntentError) || !(/** @type {any} */ (error).forever)) throw error;
          }
        }
      } catch (error) {
        // a Host's "no" is expected (its chat still has a turn open, or it refused for good: both are kept and shown); anything else is told
        if (!(error instanceof IntentError)) report(error);
      } finally {
        flushing = false;
      }
    },
    /** The messages sent to a home that is no more are not shown in the chat of the one that is. */
    forgetSent() {
      sentLog.clear();
      keep(() => sent.write([]));
    },
    /** Reset MoMo: no message is kept. */
    forget() {
      sentLog.clear();
      ledgers.clear();
      busyUntil = 0;
      busyFails = 0;
      for (const e of outbox.all()) outbox.settle(e.turnId);
      keep(() => sent.write([]));
    },
  };
}

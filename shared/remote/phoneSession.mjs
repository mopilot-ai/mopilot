// Encrypted phone channel: serialize durable ratchet writes before sending or dispatching each message.
import { PHONE_CATCH_UP_SKIP, RemoteCryptoError, createCrypto, createWalker } from './crypto.mjs';
import { EnvelopeError, checkMessage, decodeFrame, decodeMessage, fromHex, toHex, toWire, utf8 } from './envelope.mjs';

/** Hash steps walked between two breaks that let the app draw. Measured on an iPhone (Dev build) a step costs about 230 µs, so 128 steps block JS for about 30 ms and a long catch-up keeps the screen live. */
export const CHUNK_STEPS = 128;
/** The spacing of the walker's cached chain points (apart from the break, so a short break does not make a dense cache): about 0.24 s of hashing between two points. */
export const CHECKPOINT_STRIDE = 1024;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {{ prim: import('./crypto.mjs').Primitives, vault: any, pairId: string, send: (frame: object) => Promise<void>, onMessage: (message: any) => void, onMalformed?: (info: { inReplyTo: string | null }) => void, catchUpSkip?: number, onCatchUp?: (phase: 'start' | 'done' | 'failed') => void, pause?: () => Promise<void>, acker?: { enabled(): boolean, settle(frame: any, outcome: 'accepted' | 'duplicate' | 'dropped' | 'retry'): boolean } }} o */
export function createPhoneSession(o) {
  const crypto = createCrypto(o.prim);
  let active = true;
  let queue = Promise.resolve();
  /** The chain points walked from the saved counter, kept so forged far frames only make later real ones cheaper (the work for one saved counter is bounded, not timed). */
  const walker = createWalker(crypto.advance, { stride: CHECKPOINT_STRIDE, chunk: CHUNK_STEPS, cap: o.catchUpSkip ?? PHONE_CATCH_UP_SKIP });
  const run = (/** @type {() => Promise<any>} */ fn) => {
    const next = queue.then(() => {
      if (!active) throw new Error('session closed');
      return fn();
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    /** The counters of the chain points the walker holds (none at or below the saved counter after a frame opened); read-only, for tests. */
    walkedPoints: () => walker.points(),
    close() {
      active = false;
    },
    send(message) {
      // The ratchet save and the hand-off to the relay are in order, one message at a time. The relay's acknowledgement is not: the next message
      // (and a reply being read) does not wait a round trip for it, which is what made every request cost one. The caller's promise settles
      // with the acknowledgement, or with the refusal.
      return new Promise((resolve, reject) => {
        run(async () => {
          const frame = await o.vault.updatePair(o.pairId, (pair) => {
            const sender = crypto.createSender({ pair: o.pairId, dir: 'p2m', ctr: pair.tx.ctr, chain: fromHex(pair.tx.chain) });
            const wire = toWire(sender.seal(utf8(JSON.stringify(checkMessage(message)))));
            const next = sender.state();
            pair.tx = { ctr: next.ctr, chain: toHex(next.chain) };
            return { pair, value: wire };
          });
          if (!active) throw new Error('session closed');
          Promise.resolve(o.send(frame)).then(resolve, reject);
        }).catch(reject);
      });
    },
    receive(wire) {
      return run(async () => {
        let message;
        try {
          message = await open(wire).catch((error) => {
            // the Mac is far ahead of what was saved here (frames went by while this app was away): the chain still reaches it, so the walk is
            // made at a cost the phone bounds (work per saved counter, not time), and the frame must open under the pair's own chain, so nothing is trusted that was not before
            if (!(error instanceof RemoteCryptoError) || error.code !== 'gap') throw error;
            return catchUp(wire);
          });
        } catch (error) {
          if (settleFailure(wire, error)) return;
          throw error;
        }
        // the chain points walked from the old saved counter derive keys at or below the new one: none is kept once a frame opened and was saved
        walker.reset();
        if (message.malformed) {
          // The connection, the pairing and the sign-in stay: the message is dropped and noted, and a reply it answered fails only that request.
          o.acker?.settle(wire, 'dropped');
          if (active) o.onMalformed?.({ inReplyTo: message.inReplyTo });
          return;
        }
        o.acker?.settle(wire, 'accepted');
        if (active) o.onMessage(message);
      });
    },
  };

  /**
   * The walk to a frame far past the saved counter, in chunks that let the app draw, and only then the frame: it is saved only if its tag opens
   * under the chain that was walked (`open` checks the saved counter is still the one the walk began from), so a forged counter walks, fails
   * and changes nothing. A frame beyond the bound is not walked for at all.
   */
  async function catchUp(/** @type {any} */ wire) {
    const frame = decodeFrame(wire);
    const saved = await o.vault.updatePair(o.pairId, (pair) => ({ pair, value: { ctr: pair.rx.ctr, chain: pair.rx.chain } }));
    if (frame.ctr - saved.ctr > (o.catchUpSkip ?? PHONE_CATCH_UP_SKIP))
      throw new RemoteCryptoError('lost', 'this computer is too far ahead to catch up');
    // a frame at or behind the saved counter is no gap: never walked for (re-read above, so a save made since the gap was seen counts)
    if (frame.ctr <= saved.ctr) throw new RemoteCryptoError('rewind', 'the counter went back');
    o.onCatchUp?.('start');
    let done = false;
    try {
      const chain = await walker.walkTo({ ctr: saved.ctr, chain: fromHex(saved.chain) }, frame.ctr - 1, {
        yieldFn: o.pause ?? pause,
        alive: () => active,
      });
      if (!chain) throw new Error('session closed');
      const message = await open(wire, { from: saved.ctr, ctr: frame.ctr - 1, chain });
      done = true;
      return message;
    } finally {
      o.onCatchUp?.(done ? 'done' : 'failed');
    }
  }

  /** The frame read and saved in one durable step, from the saved counter (or from a walked one, `start`, when the saved one is still where the walk began). */
  function open(/** @type {any} */ wire, /** @type {{ from: number, ctr: number, chain: Uint8Array } | undefined} */ start = undefined) {
    return o.vault.updatePair(o.pairId, (pair) => {
      if (start && pair.rx.ctr !== start.from) throw new RemoteCryptoError('state', 'the saved counter moved during the catch-up');
      const receiver = crypto.createReceiver({
        pair: o.pairId,
        dir: 'm2p',
        ctr: start ? start.ctr : pair.rx.ctr,
        chain: start ? start.chain : fromHex(pair.rx.chain),
      });
      const plain = receiver.open(decodeFrame(wire));
      // An authentic frame whose payload is not a protocol message still advances the ratchet: it was opened, so it can never come again.
      let parsed;
      try {
        parsed = decodeMessage(plain);
      } catch {
        // decodeMessage throws only EnvelopeError
        parsed = { malformed: true, inReplyTo: replyTarget(plain) };
      }
      const next = receiver.state();
      pair.rx = { ctr: next.ctr, chain: toHex(next.chain) };
      return { pair, value: parsed };
    });
  }

  /**
   * With a relay that keeps frames until acked: a frame behind the ratchet is a redelivery (a lost ack), so it is acked and ignored; a frame that can
   * never be opened is acked (so it is not redelivered forever) and still fails the receive; a failed save is not acked, so it comes again.
   * @returns {boolean} whether the failure is a harmless duplicate
   */
  function settleFailure(/** @type {any} */ wire, /** @type {unknown} */ error) {
    if (!o.acker?.enabled()) return false;
    const code = error instanceof RemoteCryptoError ? error.code : null;
    const duplicate = code === 'replay' || code === 'rewind';
    if (duplicate) o.acker.settle(wire, 'duplicate');
    else if (code || error instanceof EnvelopeError) o.acker.settle(wire, 'dropped');
    return duplicate;
  }
}

/** The request a sealed payload claims to answer, when it is JSON that says so; a malformed reply fails that request instead of leaving it to time out. */
function replyTarget(/** @type {Uint8Array} */ plain) {
  try {
    const x = JSON.parse(new TextDecoder().decode(plain));
    return x && typeof x.inReplyTo === 'string' && x.inReplyTo ? x.inReplyTo : null;
  } catch {
    return null;
  }
}

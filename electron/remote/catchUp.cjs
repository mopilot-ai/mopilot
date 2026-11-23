// The Mac's catch-up for a phone whose counter is more than MAX_SKIP ahead: a chunked walk of the chain bounded by work per saved counter (a checkpoint cache), committed only when the frame's tag opens.
const { CATCH_UP_SKIP, createWalker } = require('./esm.cjs');
const { PAUSES, CATCH_UP_CHUNK, ended } = require('./sessionPause.cjs');

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Tries to open `frame`, which is past MAX_SKIP but within `skip` counters of the session's receiver. Nothing of the session is changed here
 * except the walker's cache of true chain points (derived only from the saved state): the walk runs on copies of the chain in chunks that give
 * the event loop back, and the caller replaces `s.rx` only with the receiver returned for an opened frame. The work for one saved counter is at
 * most `skip` steps plus one stride for repeated or further targets, however many forged frames arrive. 'held' when the session paused (a full queue, a failed save)
 * meanwhile: the frame is not judged, and the relay sends it again. Null (nothing opened, nothing changed) when the frame is beyond the cap,
 * the session ended or changed meanwhile, or the tag fails.
 * @param {{ s: any, frame: any, crypto: any, skip?: number, current: () => boolean }} o
 * @returns {Promise<{ rx: any, plain: Uint8Array } | 'held' | null>}
 */
async function catchUpOpen({ s, frame, crypto, skip = CATCH_UP_SKIP, current }) {
  const base = s.rx.state();
  if (frame.ctr <= base.ctr || frame.ctr - base.ctr > skip) return null;
  s.walker ??= createWalker(crypto.advance, { stride: CATCH_UP_CHUNK, cap: skip });
  const chain = await s.walker.walkTo(base, frame.ctr - 1, { yieldFn: turn, alive: () => !ended(s) });
  // paused meanwhile: the relay sends the frame again once the session is back, and the walk's checkpoints make that cheap
  if (s.closed && PAUSES.has(s.closed)) return 'held';
  // the receiver moved meanwhile (a restore after a failed save, a removed pair): this frame was judged against a state that is gone
  if (!chain || !current() || s.rx.state().ctr !== base.ctr || s.closed) return null;
  const rx = crypto.createReceiver({ pair: frame.pair, dir: 'p2m', ctr: frame.ctr - 1, chain });
  try {
    return { rx, plain: rx.open(frame) };
  } catch {
    return null;
  }
}

/** `catchUpOpen` with the channel's own pieces. @param {any} ch the RemoteChannel @param {any} s @param {any} frame */
const catchUpFrom = (ch, s, frame) =>
  catchUpOpen({ s, frame, crypto: ch.crypto, skip: ch.o.catchUpSkip, current: () => ch.sessions.get(frame.pair) === s });

/** A frame opened and its counters are saved: no chain point at or below them may stay in memory (a chain value derives every later key). @param {{ walker?: { reset(): void } }} s */
const forgetWalked = (s) => s.walker?.reset();

module.exports = { catchUpOpen, catchUpFrom, forgetWalked };

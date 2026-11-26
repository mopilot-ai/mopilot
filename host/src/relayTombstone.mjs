// A removed controller's relay link as the Host keeps it for a while (#5747): the pair is the other Mac's (it issued the credential), so the Host cannot take it off the relay. The link stays as a tombstone that answers every request on every stream with `unknown_client` (marked `linkRemoved`, so the other Mac removes its own pair), never reaches the Host's socket, and is forgotten when the pair goes or after TOMBSTONE_MS.
import { createDecoder, encodeControl } from '../../shared/host/frames.mjs';

/** How long a tombstone is kept when the other Mac never comes back to hear it. */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
/** How often a running Host looks for tombstones past their time. */
export const SWEEP_MS = 6 * 60 * 60_000;
/** How many answers one stream gets before it is ended (a client that asks on and on is not answered for ever). */
const MAX_ANSWERS = 8;
/** The longest request line a tombstone reads. */
const MAX_LINE = 64 * 1024;
const REFUSAL = 'This Mac removed this client. Pair again with a new code.';

/** The most tombstones one Host keeps; past it the oldest go first. */
export const MAX_TOMBSTONES = 16;

/** Whether an enrollment is a tombstone past its time; a time that is not a number (a file edited by hand) is past it, so the link goes rather than staying for ever. @param {{ retiredAt?: unknown }} e @param {number} now */
export const expired = (e, now) => e.retiredAt !== undefined && !(typeof e.retiredAt === 'number' && now - e.retiredAt < TOMBSTONE_MS);

/**
 * The tombstones to forget now, each with why: the ones past their time, then the oldest past MAX_TOMBSTONES.
 * @param {{ hostId: string, retiredAt?: unknown }[]} all @param {number} now @returns {{ hostId: string, outcome: 'expired' | 'evicted' }[]}
 */
export function staleTombstones(all, now) {
  const tombs = all.filter((e) => e.retiredAt !== undefined);
  const old = tombs.filter((e) => expired(e, now));
  const live = tombs.filter((e) => !expired(e, now)).sort((x, y) => Number(x.retiredAt) - Number(y.retiredAt));
  return [
    ...old.map((e) => ({ hostId: e.hostId, outcome: /** @type {const} */ ('expired') })),
    ...live
      .slice(0, Math.max(0, live.length - MAX_TOMBSTONES))
      .map((e) => ({ hostId: e.hostId, outcome: /** @type {const} */ ('evicted') })),
  ];
}

/**
 * Serves one stream of a tombstone: `ping` is answered (the app's first question, which carries no trust), anything else is refused as an unknown client; nothing is ever passed on.
 * @param {import('../../shared/host/relaySession.mjs').RelayStream} stream
 */
export function refuseStream(stream) {
  const decoder = createDecoder({ maxFrame: MAX_LINE });
  let answers = 0;
  stream.onData = (bytes) => {
    stream.consumed(bytes.length);
    let frames;
    try {
      frames = decoder.push(bytes);
    } catch {
      return stream.reset();
    }
    for (const f of frames) {
      const m = f.kind === 'control' ? f.message : f.meta;
      const id = typeof m.id === 'number' ? m.id : null;
      stream.write(
        encodeControl(
          m.method === 'ping' ? { id, result: 'pong' } : { id, error: REFUSAL, code: 'unknown_client', details: { linkRemoved: true } },
        ),
      );
      if (++answers >= MAX_ANSWERS) return stream.end();
    }
  };
  stream.onEnd = () => stream.end();
  stream.onReset = () => undefined;
}

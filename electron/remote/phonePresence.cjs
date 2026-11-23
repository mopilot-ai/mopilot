// Which paired phones are connected to the relay right now, from the relay's hello and its `peer` events; Settings shows these as Online.

/** A frame received this soon after the relay's hello (or its `peer offline`) for a pair never makes the phone present: the relay sends the hello and then flushes the phone's backlog. */
const GRACE_MS = 5000;
/** A frame makes the phone present only if the time inside its sealed payload (the phone's own clock, so authenticated) is this close to the Mac's clock: an old frame is not news of now. */
const FRESH_MS = 120_000;

/**
 * Nothing counts as online while the Mac's own socket is down, or when the relay does not send `peer` events for phones (an older relay:
 * its hello's peerOnline would never change, so it is not trusted).
 * A frame from a phone makes it present only if it was received more than GRACE_MS after the relay last said anything about the pair's
 * absence (the hello, or `peer offline`: the backlog of a phone that is gone is delivered right after the hello and looks newer than the
 * mark) and its authenticated time is fresh; the relay's own `peer online` still decides everything else.
 * @param {{ on(kind: 'state' | 'open' | 'event', fn: (v: any) => void): () => void }} relay
 * @param {() => number} [mono] a clock that never goes back, shared with the channel's receive times
 * @param {() => number} [now] the wall clock, for the freshness of a frame's own time
 */
function createPhonePresence(relay, mono = () => performance.now(), now = Date.now) {
  /** @type {Set<string>} */
  let online = new Set();
  // the relay says when phones leave, so what it says of phones arriving can be kept
  let trusted = false;
  /** whether this Mac's own socket is open: what the phones' absence means only then */
  let up = false;
  /** When the relay last gave news of each pair that may be away: its hello, or `peer offline`. @type {Map<string, number>} */
  const awayAt = new Map();
  relay.on('state', (state) => {
    up = state === 'open';
    if (state !== 'open') online = new Set();
  });
  relay.on('open', ({ pairs, peerEvents }) => {
    up = true;
    trusted = peerEvents;
    const mine = peerEvents ? pairs.filter((p) => p?.role === 'mac' && typeof p.pair === 'string') : [];
    online = new Set(mine.filter((p) => p.peerOnline === true).map((p) => p.pair));
    for (const p of mine) awayAt.set(p.pair, mono());
  });
  relay.on('event', (event) => {
    // a phone joins a pair while it is connected; the relay sends no `peer` event for that connection
    if (trusted && event?.ev === 'pair.joined' && typeof event.pair === 'string') return void online.add(event.pair);
    if (event?.ev !== 'peer' || typeof event.pair !== 'string') return;
    if (event.online === true) online.add(event.pair);
    else {
      online.delete(event.pair);
      awayAt.set(event.pair, mono());
    }
  });
  return {
    isOnline: (/** @type {string} */ pairId) => online.has(pairId),
    /**
     * A frame of this pair's own chain opened and was decoded: the phone is connected, whatever the relay has said (its `peer online` may come
     * late), unless the frame is the relay's backlog (received within the grace after its hello or `peer offline`) or older than FRESH_MS by
     * the phone's own clock. @param {string} pairId @param {number} receivedAt mono time @param {number} sentAt the message's own `t`
     */
    markPresent: (pairId, receivedAt, sentAt) =>
      void (
        trusted &&
        up &&
        receivedAt - (awayAt.get(pairId) ?? -Infinity) > GRACE_MS &&
        Math.abs(now() - sentAt) <= FRESH_MS &&
        online.add(pairId)
      ),
    /** The relay says this phone is not connected (never true for a relay that does not report phones, or while this Mac's own socket is down). */
    isAbsent: (/** @type {string} */ pairId) => trusted && up && !online.has(pairId),
  };
}

module.exports = { createPhonePresence, GRACE_MS, FRESH_MS };

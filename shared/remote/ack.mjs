// The receipt contract between a peer (the Mac or the phone) and the relay's durable mailbox: after a sealed frame is safely the peer's own it sends { t:'ack', pair, dir, ctr } and the relay forgets the frame; until then the relay redelivers it on every reconnect, so a peer must expect duplicates and ack those too.

export const ACK_TYPE = 'ack';

/** The direction a role receives on: the Mac gets what the phone sent (p2m), the phone what the Mac sent (m2p). @param {'mac' | 'phone'} role */
export const incomingDir = (role) => (role === 'mac' ? 'p2m' : 'm2p');

/** The wire message acknowledging one received frame. @param {{ pair: string, dir: string, ctr: number }} frame */
export const encodeAck = (frame) => ({ t: ACK_TYPE, pair: frame.pair, dir: frame.dir, ctr: frame.ctr });

/** Whether the relay's hello says it keeps frames until they are acknowledged; a relay that does not would reject an ack. @param {any} hello */
export const relayAcks = (hello) => hello?.acks === true;

/**
 * What a peer concluded about a delivered frame:
 *  accepted  it is now durably held (the receive state is saved) and will be handled
 *  duplicate it was handled before (a redelivery after a lost ack or a crash between save and ack)
 *  dropped   it can never be accepted (forged, malformed, for a closed or unknown session), so redelivering it would only repeat the failure
 *  retry     it could not be stored this time (a disk error); no ack, so the relay redelivers it after the next reconnect
 * @typedef {'accepted' | 'duplicate' | 'dropped' | 'retry'} ReceiptOutcome
 */

/** Acks only after an outcome that is final, and only while the relay supports acks. */
export class ReceiptAcker {
  /** @param {{ send: (m: object) => boolean, enabled: () => boolean }} o */
  constructor(o) {
    this.o = o;
  }

  /** Whether the relay currently keeps frames until acked, so a peer must expect redeliveries. */
  enabled() {
    return this.o.enabled();
  }

  /** @param {{ pair: string, dir: string, ctr: number }} frame @param {ReceiptOutcome} outcome @returns {boolean} whether an ack went out */
  settle(frame, outcome) {
    if (outcome === 'retry' || frame.ctr < 1 || !this.o.enabled()) return false;
    return this.o.send(encodeAck(frame)) === true;
  }
}

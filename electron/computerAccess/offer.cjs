// Computer access (#1364): the pairing offer this Mac shows and a client pastes, and the one-time secret in it.
//
// An offer is `mopilot-access:1:<address>:<port>:<host key fingerprint>:<secret>`. The address is a host name, an
// IPv4 address or a bracketed IPv6 address; the fingerprint lets the client check that the computer answering is
// the one that showed the offer; the secret (32 bytes) is single use and short lived (PairingOffers).
const crypto = require('node:crypto');

const PREFIX = 'mopilot-access';
const VERSION = 1;
/** How long an offer can be used. */
const OFFER_MS = 5 * 60 * 1000;
const OFFER = /^mopilot-access:1:([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]):(\d{1,5}):([0-9a-f]{32}):([A-Za-z0-9_-]{43})$/;

/**
 * Reads an offer; null when it is not one.
 * @param {unknown} text
 * @returns {{ address: string, port: number, fingerprint: string, secret: string } | null}
 */
function parseOffer(text) {
  const m = OFFER.exec(String(text ?? '').trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { address: m[1], port, fingerprint: m[3], secret: m[4] };
}

/** @param {{ address: string, port: number, fingerprint: string, secret: string }} o */
const offerText = (o) => `${PREFIX}:${VERSION}:${o.address}:${o.port}:${o.fingerprint}:${o.secret}`;

/**
 * The host's open offer: at most one at a time, it expires, and the first pairing hello uses it up.
 */
class PairingOffers {
  /** @param {{ now?: () => number, ttlMs?: number }} [o] */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? OFFER_MS;
    /** @type {{ secret: string, expiresAt: number } | null} */
    this.open = null;
  }

  /**
   * A new offer for the address and port the host listens on; any earlier offer stops working.
   * @param {{ address: string, port: number, fingerprint: string }} o
   */
  start(o) {
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.open = { secret, expiresAt };
    return { text: offerText({ ...o, secret }), expiresAt };
  }

  /** The offer still open now, or null: one past its time no longer pairs, so nothing should show it. */
  current() {
    return this.open && this.now() <= this.open.expiresAt ? this.open : null;
  }

  /** The person closed the pairing dialog: the offer stops working. */
  cancel() {
    this.open = null;
  }

  /**
   * The secret of the offer open right now, which this call uses up; null when none is open or it expired. The
   * handshake mixes it in, so a client with another secret fails there, and the offer is gone either way: a
   * stolen offer can be tried once, and the person who showed it sees that it no longer works.
   */
  take() {
    const o = this.open;
    if (!o) return null;
    this.open = null;
    return this.now() > o.expiresAt ? null : o.secret;
  }
}

module.exports = { parseOffer, offerText, PairingOffers, OFFER_MS };

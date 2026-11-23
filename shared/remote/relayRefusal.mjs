// The relay's refusals as the Mac and the phone read them (relay/src/access.mjs sends them): the close code of each, what a person is told, and how long a client waits before it asks again.

/** @typedef {'capacity' | 'account_limit' | 'disabled'} RelayRefusal */

/** @type {Readonly<Record<number, RelayRefusal>>} the relay's close codes: it holds all the sockets it serves · the account has its most devices connected · the account's relay access is switched off */
const BY_CODE = Object.freeze({ 4503: 'capacity', 4429: 'account_limit', 4423: 'disabled' });

/** The refusal a close code names, or null for any other close. @param {unknown} code @returns {RelayRefusal | null} */
export const refusalOf = (code) => (typeof code === 'number' && Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : null);

/** What the account service answers `POST /api/desktop/relay-token` (HTTP 403, `error`) for an account whose relay access is switched off. */
export const RELAY_DISABLED_ERROR = 'relay_disabled';

/** @type {Readonly<Record<RelayRefusal, string>>} what the person reads, on the Mac and on the phone */
export const REFUSAL_TEXT = Object.freeze({
  capacity: 'Mobile Remote is at capacity. Try again shortly.',
  account_limit:
    'Too many of your devices are connected to Mobile Remote. Close MoPilot on one of them; this one reconnects by itself within a few minutes.',
  disabled: 'Mobile Remote is turned off for this account. Contact support if you think this is a mistake.',
});

/** A refused client asks again after 15 s, doubling to 5 minutes: a full relay is not helped by every client it turned away dialing again at once. */
export const REFUSAL_BASE_MS = 15_000;
export const REFUSAL_CAP_MS = 5 * 60_000;

/**
 * How long to wait after the `refusals`-th refusal in a row (0 for the first), between half and all of the doubled wait so the
 * clients a full relay turned away together do not come back together.
 * @param {number} refusals @param {number} random a number in [0, 1)
 */
export const refusalWait = (refusals, random) =>
  Math.round(Math.min(REFUSAL_CAP_MS, REFUSAL_BASE_MS * 2 ** Math.min(refusals, 10)) * (0.5 + random / 2));

/** The relay, or the account service on its behalf, refused this device; `refusal` says which way and the message is what the person reads. */
export class RelayRefused extends Error {
  /** @param {RelayRefusal} refusal */
  constructor(refusal) {
    super(REFUSAL_TEXT[refusal]);
    this.name = 'RelayRefused';
    this.refusal = refusal;
  }
}

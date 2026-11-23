// The pairings MoPilot offers its Chrome extension (#1632): the one-time claim code, and "Allow Chrome to connect?", the one in-app question asked when the extension asks by itself, as ChatGPT asks once before it uses the user's Chrome.
//
// A claim code is offered by Settings' Pair, by the Allow card (both the user's) or by a chat's wait; it is good once,
// for CLAIM_MS, and a new offer replaces it. The extension asks the verified native host on install, at startup and on
// its alarm while it isn't paired (src/background.mjs). With no offer of the user's, main answers PENDING and raises the
// question; the extension asks again every few seconds. Allow offers a claim as good as Settings' Pair, which the next
// ask takes; Not now leaves the extension's asks unanswered until the user pairs from Settings or MoPilot restarts.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { sameText, claimCode } = require('./chromeExtensionTransport.cjs');

const CLAIM_MS = 120_000;
/** The question goes when the extension hasn't asked for this long (it asks every 2 s, then on its 30 s alarm). */
const STALE_MS = 90_000;
/** What main tells the native host while the question is up (the extension asks again). */
const PENDING = Object.freeze({ pending: true });

class PairOffers extends EventEmitter {
  constructor({ now = () => Date.now(), timers = { setTimeout, clearTimeout } } = {}) {
    super();
    this.now = now;
    this.timers = timers;
    /** @type {any} drops the question once the extension stopped asking (uninstalled, Chrome quit) */
    this.stale = null;
    /** @type {{ token: string, until: number, user: boolean } | null} the open claim (user: the user offered it) */
    this.current = null;
    /** the question is up in MoPilot */
    this.asking = false;
    /** the user said Not now: the extension's own asks raise nothing more this run */
    this.declined = false;
  }

  /** Offers a new claim code, replacing any earlier one; resolves with its token. */
  offer(/** @type {boolean} */ user) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.current = { token, until: this.now() + CLAIM_MS, user };
    return token;
  }

  /** The open claim, while it is good. */
  #open() {
    const c = this.current;
    return c && this.now() <= c.until ? c : null;
  }

  /** Whether the user's own offer is open (a chat's wait then opens no second page). */
  userOffer() {
    return !!this.#open()?.user;
  }

  /** Takes the claim `token` names: true once, and only in time. */
  take(/** @type {string} */ token) {
    const c = this.#open();
    if (!c || !sameText(token, c.token)) return false;
    this.current = null;
    return true;
  }

  /**
   * What the native host hands the extension at `port`: the open claim's code; for an ask the extension made by itself
   * (`auto`), only a claim the user offered, else PENDING while the question is up (raised now, unless declined or the
   * extension is connected); null otherwise.
   * @param {{ auto: boolean, port: number, connected: boolean }} o
   * @returns {string | typeof PENDING | null}
   */
  forHost({ auto, port, connected }) {
    const c = this.#open();
    if (c && (!auto || c.user)) return claimCode(port, c.token);
    if (!auto || connected || this.declined) return null;
    if (!this.asking) this.#set(true);
    this.timers.clearTimeout(this.stale);
    this.stale = this.timers.setTimeout(() => this.asking && this.#set(false), STALE_MS);
    this.stale?.unref?.();
    return PENDING;
  }

  /** The user's answer; false when no question was up. Allow offers a claim of the user's; Not now holds until reset(). */
  answer(/** @type {boolean} */ allow) {
    if (!this.asking) return false;
    if (allow) this.offer(true);
    else this.declined = true;
    this.#set(false);
    return true;
  }

  /** The extension connected, or the user paired from Settings: the question goes, and a later ask may raise it again. */
  reset() {
    this.declined = false;
    if (this.asking) this.#set(false);
  }

  #set(asking) {
    if (!asking) this.timers.clearTimeout(this.stale);
    this.asking = asking;
    this.emit('change', asking);
  }
}

module.exports = { PairOffers, PENDING, CLAIM_MS, STALE_MS };

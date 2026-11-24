// Rendezvous for pairing two computers by a short code (#5576, design revision 2): the controlled Mac's Host opens an offer and is given a random 128-bit id and a 3-character hint; the code the person types is that hint and 5 secret characters the relay never sees; the controlling Mac claims the hint and the two exchange a few small sealed messages through this mailbox. The relay takes no part in the cryptography: it keeps no key, no password and no plaintext, and everything it holds is memory of this process for at most 5 minutes (a restart cancels every offer).
// What bounds it: a limited number of live offers (all, and per account); offers and claims per caller, where a caller is an IPv4 address or an IPv6 /64 (and, wider, its /48), so a block that can make millions of addresses is one caller; every table of those limits is capped, with one shared bucket past the cap; 5 claims per offer (denial-of-service control only: the Host that made the offer counts failed confirmations itself and burns the code); a few messages of a few KiB each, which each side sends in turn and for the claim it read; and a request rate per offer. Every failure of a claim (no such hint, used up, expired, claimed too often) is the same answer.
// A stranger who guesses a live hint can take the claimant's place and use up the claims: that is inherent to a 3-character hint, bounded by the address limits, and the Host that made the offer shows only a neutral "this code was used up" and offers a new one in a click.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { TokenBucket } from './rateLimit.mjs';

/** The characters of a code: no 0, O, 1, I or L. */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const HINT_LENGTH = 3;
/** How long an offer lives, whatever happens. */
export const OFFER_MS = 5 * 60_000;
/** Messages one offer may hold (a run is four; a few more cover a retry), and the most each may carry (characters of base64url). */
export const MAX_MESSAGES = 6;
export const MAX_BOX_CHARS = 2800;
/** Claims one offer takes: past them it answers every claim as if it were not there. */
export const CLAIMS_PER_OFFER = 5;
/** Tries to find a hint no live offer has: with at most `live` offers of the 29,791 hints there are, one is found at once; past the bound the offer is refused as busy. */
const HINT_TRIES = 200;
export const LIMITS = Object.freeze({
  /** offers alive at once, in all and for one account */
  live: 5000,
  perAccount: 3,
  /** offers one caller may make in an hour, and claims in a minute and in an hour */
  offersPerHour: 10,
  claimsPerMinute: 30,
  claimsPerHour: 200,
  /** requests a second one offer's mailbox answers (a client polls a few times a second at most), and its burst */
  perOfferPerSecond: 8,
  perOfferBurst: 60,
  /** the IPv6 /48 a /64 sits in is one caller at this many times the /64's limits */
  wideFactor: 8,
  /** the most buckets each limit keeps; past it every new caller shares one bucket, so a flood of addresses cannot grow memory */
  bucketCap: 20_000,
});

export const OFFER_ID = /^r_[A-Za-z0-9_-]{22}$/;
const TICKET = /^[A-Za-z0-9_-]{22}$/;
const HINT = new RegExp(`^[${ALPHABET}]{${HINT_LENGTH}}$`);
const BOX = /^[A-Za-z0-9_-]+$/;

/** A random value of 128 bits as base64url. */
const token = () => randomBytes(16).toString('base64url');
/** Whether two tickets are the same, without telling by time where they differ. @param {string} a @param {string} b */
const same = (a, b) => createHash('sha256').update(a).digest().equals(createHash('sha256').update(b).digest());

/** A dotted IPv4 address, or null (each part a whole number of at most 255). @param {string} text */
const dotted = (text) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  return m && m.slice(1).every((n) => Number(n) <= 255) ? m.slice(1).map(Number) : null;
};

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail counts as its two groups), or null when it is not one. @param {string} text */
function groupsOf(text) {
  const tail4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  const octets = tail4 ? dotted(/** @type {string} */ (tail4[2])) : null;
  if (tail4 && !octets) return null;
  const o = /** @type {[number, number, number, number]} */ (octets);
  const plain = tail4 ? `${tail4[1]}${(o[0] * 256 + o[1]).toString(16)}:${(o[2] * 256 + o[3]).toString(16)}` : text;
  const halves = plain.split('::');
  if (halves.length > 2) return null;
  const part = (/** @type {string} */ t) => (t === '' ? [] : t.split(':'));
  const left = part(/** @type {string} */ (halves[0]));
  const right = part(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...left, ...Array(missing).fill('0'), ...right];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all.map((g) => g.padStart(4, '0')) : null;
}

/**
 * Who a remote address is for the limits: an IPv4 address by itself (also when it is written as an IPv6 address: mapped, `::ffff:1.2.3.4`, `::ffff:0102:0304`, `0:0:0:0:0:ffff:1.2.3.4`, or the old compatible form `::1.2.3.4`), an IPv6 address by its /64 (and, as a wider key, its /48). Anything else is its own text, cut short.
 * @param {string} address @returns {{ primary: string, wide: string | null }}
 */
export function callerOf(address) {
  const text = String(address).trim().toLowerCase().replace(/%.*$/, '');
  const plain = dotted(text);
  if (plain) return { primary: plain.join('.'), wide: null };
  const groups = text.includes(':') ? groupsOf(text) : null;
  if (!groups) return { primary: text.slice(0, 64), wide: null };
  const embedded =
    groups.slice(0, 5).every((g) => g === '0000') &&
    (groups[5] === 'ffff' || (groups[5] === '0000' && !/^0000:000[01]$/.test(`${groups[6]}:${groups[7]}`)));
  if (embedded) {
    const hi = Number.parseInt(/** @type {string} */ (groups[6]), 16);
    const lo = Number.parseInt(/** @type {string} */ (groups[7]), 16);
    return { primary: [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'), wide: null };
  }
  return { primary: `${groups.slice(0, 4).join(':')}/64`, wide: `${groups.slice(0, 3).join(':')}/48` };
}

/** How many shared buckets take the callers a full table has no place for: one flood of keys then throttles only the callers whose key falls in the shards it fills, not every new caller. */
const SHARDS = 16;

/** Token buckets by key, at most `cap` of them: a key past the cap (after the buckets that refilled are dropped, at most once a second) shares one of a few buckets by its key, so what an attacker can make of keys cannot grow memory. */
class Limiter {
  /** @param {number} perSecond @param {number} burst @param {() => number} now @param {number} cap */
  constructor(perSecond, burst, now, cap) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.cap = cap;
    /** @type {Map<string, TokenBucket>} */
    this.map = new Map();
    this.shared = Array.from({ length: SHARDS }, () => new TokenBucket(perSecond, burst, now));
    this.pruned = 0;
    /** how many times a full table was scanned for buckets that refilled */
    this.scans = 0;
  }

  /** The wait in milliseconds before `key` may go on, 0 (and a token taken) when it may now. @param {string} key */
  tryTake(key) {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.cap && this.now() - this.pruned >= 1000) {
        this.pruned = this.now();
        this.scans++;
        this.prune();
      }
      if (this.map.size >= this.cap) {
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return /** @type {TokenBucket} */ (this.shared[h % SHARDS]).tryTake();
      }
      this.map.set(key, (b = new TokenBucket(this.perSecond, this.burst, this.now)));
    }
    return b.tryTake();
  }

  /** Forgets every bucket that is full again. */
  prune() {
    for (const [key, b] of this.map) if (b.idle) this.map.delete(key);
  }
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {import('./metrics.mjs').Metrics} [o.metrics] gets counts only, never an id, a hint or a ticket
 * @param {Record<keyof typeof LIMITS, number>} [o.limits]
 */
export function createRendezvous({ now = Date.now, metrics, limits = LIMITS } = {}) {
  /**
   * @typedef {{ hint: string, account: string, expiresAt: number, ticketB: string, ticketA: string | null, claims: number, messages: { n: number, from: 'a' | 'b', box: string }[], next: number }} Offer
   * @type {Map<string, Offer>}
   */
  const offers = new Map();
  /** @type {Map<string, string>} the hint of each live offer, to its id */
  const byHint = new Map();
  /** @type {Map<string, number>} */
  const perAccount = new Map();
  const wide = limits.wideFactor;
  const cap = limits.bucketCap;
  const offerLimit = new Limiter(limits.offersPerHour / 3600, limits.offersPerHour, now, cap);
  const offerLimitWide = new Limiter((limits.offersPerHour * wide) / 3600, limits.offersPerHour * wide, now, cap);
  const claimMinute = new Limiter(limits.claimsPerMinute / 60, limits.claimsPerMinute, now, cap);
  const claimMinuteWide = new Limiter((limits.claimsPerMinute * wide) / 60, limits.claimsPerMinute * wide, now, cap);
  const claimHour = new Limiter(limits.claimsPerHour / 3600, limits.claimsPerHour, now, cap);
  const claimHourWide = new Limiter((limits.claimsPerHour * wide) / 3600, limits.claimsPerHour * wide, now, cap);
  /** a bucket for each live offer (and no more: its place goes with the offer) */
  const mailbox = new Limiter(limits.perOfferPerSecond, limits.perOfferBurst, now, limits.live);
  const limiters = [offerLimit, offerLimitWide, claimMinute, claimMinuteWide, claimHour, claimHourWide, mailbox];
  const count = (/** @type {string} */ name, /** @type {Record<string, string>} */ labels = {}) =>
    metrics?.inc(`relay_rendezvous_${name}`, labels);
  /** Whether a caller may go on: its /48's bucket when it has one, then its own. @param {Limiter} own @param {Limiter} widest @param {string} address */
  const allowed = (own, widest, address) => {
    const { primary, wide: w } = callerOf(address);
    // the wider range first: a request its range has no room for makes no bucket of its own, so one /48 cannot fill the table with /64s
    return (w === null || widest.tryTake(w) === 0) && own.tryTake(primary) === 0;
  };

  /** @param {string} id */
  const drop = (id) => {
    const o = /** @type {Offer} */ (offers.get(id));
    offers.delete(id);
    if (byHint.get(o.hint) === id) byHint.delete(o.hint);
    const left = /** @type {number} */ (perAccount.get(o.account)) - 1;
    if (left > 0) perAccount.set(o.account, left);
    else perAccount.delete(o.account);
    mailbox.map.delete(id);
  };
  /** The offer an id names while it lives, or undefined (an expired one goes now). @param {unknown} id */
  const live = (id) => {
    const o = typeof id === 'string' && OFFER_ID.test(id) ? offers.get(id) : undefined;
    if (!o) return undefined;
    if (o.expiresAt <= now()) return void drop(/** @type {string} */ (id));
    return o;
  };
  /** A hint no live offer has, drawn at random; null when none was found in a bounded number of tries. */
  const freeHint = () => {
    for (let i = 0; i < HINT_TRIES; i++) {
      let h = '';
      for (let j = 0; j < HINT_LENGTH; j++) h += ALPHABET[randomInt(ALPHABET.length)];
      if (!byHint.has(h)) return h;
    }
    return null;
  };

  return {
    /** Offers alive now. */
    get size() {
      return offers.size;
    },
    /** How many scans for refilled buckets the limits made of a full table, for a test of the bound. */
    get scans() {
      return limiters.reduce((n, l) => n + l.scans, 0);
    },
    /** How many buckets each limit holds, for a test of the bound. */
    get buckets() {
      return limiters.map((l) => l.map.size);
    },
    /**
     * A Host opens an offer. `busy` when the relay or the account holds as many as it may, `limited` when this caller made too many.
     * @param {{ account: string, address: string }} o
     * @returns {{ ok: true, id: string, hint: string, ticket: string, expiresAt: number } | { ok: false, reason: 'limited' | 'busy' | 'account_limit' }}
     */
    offer({ account, address }) {
      if (!allowed(offerLimit, offerLimitWide, address)) return count('refused', { why: 'limited' }), { ok: false, reason: 'limited' };
      if ((perAccount.get(account) ?? 0) >= limits.perAccount)
        return count('refused', { why: 'account_limit' }), { ok: false, reason: 'account_limit' };
      const hint = offers.size >= limits.live ? null : freeHint();
      if (!hint) return count('refused', { why: 'busy' }), { ok: false, reason: 'busy' };
      const id = `r_${token()}`;
      const expiresAt = now() + OFFER_MS;
      const ticket = token();
      offers.set(id, { hint, account, expiresAt, ticketB: ticket, ticketA: null, claims: 0, messages: [], next: 1 });
      byHint.set(hint, id);
      perAccount.set(account, (perAccount.get(account) ?? 0) + 1);
      count('offers');
      return { ok: true, id, hint, ticket, expiresAt };
    },
    /**
     * A client asks for the offer a hint names. Every refusal that is about the hint is `null`, whatever its cause; a hint that is not one costs nothing and is nothing. A new claim takes the place of the one before it (and clears the messages), and an offer takes only so many.
     * @param {{ hint: unknown, address: string }} o
     * @returns {{ id: string, ticket: string, claims: number } | null | 'limited'}
     */
    claim({ hint, address }) {
      const text = typeof hint === 'string' ? hint.toUpperCase() : '';
      if (!HINT.test(text)) return null;
      if (!allowed(claimMinute, claimMinuteWide, address) || !allowed(claimHour, claimHourWide, address))
        return count('refused', { why: 'claims_limited' }), 'limited';
      const id = byHint.get(text);
      const o = live(id);
      if (!o || !id || o.claims >= CLAIMS_PER_OFFER) return count('claims', { result: 'none' }), null;
      o.claims++;
      o.ticketA = token();
      o.messages = [];
      o.next = 1;
      count('claims', { result: 'taken' });
      return { id, ticket: o.ticketA, claims: o.claims };
    },
    /**
     * Puts a sealed message in the mailbox for the other side. The ticket says which side this is, `claims` must be the claim the sender read (a message for an earlier claim is nothing, so a Host's answer never lands in the next claimant's mailbox), and a side sends in turn: not again before the other side has put a message after its last.
     * @param {{ id: unknown, ticket: unknown, claims: unknown, box: unknown }} o
     * @returns {{ ok: true, n: number } | { ok: false, reason: 'gone' | 'bad' | 'full' | 'limited' | 'wait' }}
     */
    send({ id, ticket, claims, box }) {
      const o = live(id);
      const side = sideOf(o, ticket);
      if (!o || !side || o.claims < 1 || claims !== o.claims) return { ok: false, reason: 'gone' };
      if (mailbox.tryTake(/** @type {string} */ (id)) > 0) return { ok: false, reason: 'limited' };
      if (typeof box !== 'string' || box.length === 0 || box.length > MAX_BOX_CHARS || !BOX.test(box)) return { ok: false, reason: 'bad' };
      if (o.messages.length >= MAX_MESSAGES) return { ok: false, reason: 'full' };
      if (o.messages.at(-1)?.from === side) return { ok: false, reason: 'wait' };
      const n = o.next++;
      o.messages.push({ n, from: side, box });
      return { ok: true, n };
    },
    /**
     * What the other side sent after `after`, and how many claims the offer has had (a claim starts a run again, and the offering side starts its state again).
     * @param {{ id: unknown, ticket: unknown, after: unknown }} o
     * @returns {{ ok: true, claims: number, messages: { n: number, box: string }[], expiresAt: number } | { ok: false, reason: 'gone' | 'limited' }}
     */
    read({ id, ticket, after }) {
      const o = live(id);
      const side = sideOf(o, ticket);
      if (!o || !side) return { ok: false, reason: 'gone' };
      if (mailbox.tryTake(/** @type {string} */ (id)) > 0) return { ok: false, reason: 'limited' };
      const from = Number.isSafeInteger(after) && /** @type {number} */ (after) > 0 ? /** @type {number} */ (after) : 0;
      return {
        ok: true,
        claims: o.claims,
        expiresAt: o.expiresAt,
        messages: o.messages.filter((m) => m.from !== side && m.n > from).map(({ n, box }) => ({ n, box })),
      };
    },
    /** Ends an offer (cancelled, finished or used up by the Host): its hint is free again at once. @param {{ id: unknown, ticket: unknown }} o */
    close({ id, ticket }) {
      const o = live(id);
      if (!o || !sideOf(o, ticket)) return false;
      drop(/** @type {string} */ (id));
      count('closed');
      return true;
    },
    /** Forgets every offer that ran out, and the buckets that are full again: run by the relay's own timer, never by a request. */
    sweep() {
      for (const [id, o] of offers) if (o.expiresAt <= now()) drop(id);
      for (const l of limiters) l.prune();
      metrics?.set('relay_rendezvous_live', offers.size);
    },
  };
}

/** Which side holds this ticket: the offering Host (`b`) or the claimant (`a`). @param {{ ticketA: string | null, ticketB: string } | undefined} o @param {unknown} ticket @returns {'a' | 'b' | null} */
function sideOf(o, ticket) {
  if (!o || typeof ticket !== 'string' || !TICKET.test(ticket)) return null;
  if (same(ticket, o.ticketB)) return 'b';
  return o.ticketA && same(ticket, o.ticketA) ? 'a' : null;
}

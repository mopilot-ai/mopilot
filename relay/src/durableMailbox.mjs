// The hub's view of the durable store (durableStore.mjs): resolves a pair's epoch and trusted limits so the wire needs neither, and keeps a frame stored until its receiver acknowledges it.

import { limitsOf } from './limits.mjs';
import { messageOf } from './processGuards.mjs';

/** How long the relay-wide usage is trusted before it is read again. */
const USAGE_MS = 10_000;

/** Which mailbox caps refuse frames: a pair's, its account's or the relay's, and `plain` for the plain mailbox, whose statement does not say which. */
export const MAILBOX_SCOPES = ['pair', 'account', 'relay', 'plain'];
const FULL_HELP =
  'Frames refused because a mailbox cap was reached, by which: pair, account or relay (plain: the plain mailbox, any of its caps)';

/** Counts a frame refused at a mailbox cap (0 seeds the series for a scrape). @param {import('./metrics.mjs').Metrics} metrics @param {string} [scope] */
export const countMailboxFull = (metrics, scope = 'pair', n = 1) => metrics.inc('relay_mailbox_full_total', { scope }, n, FULL_HELP);

export class DurableMailbox {
  /**
   * @param {object} o
   * @param {import('./durableStore.mjs').DurableStore} o.durable
   * @param {{ mailbox: { ttlMs: number, maxFrames: number, maxBytes: number }, limits?: Partial<import('./limits.mjs').Limits> }} o.config
   * @param {() => number} o.now
   * @param {import('./limits.mjs').Limits} [o.limits]
   * @param {(event: string, data: object) => void} o.log
   */
  constructor({ durable, config, now, limits = limitsOf(config), log }) {
    this.log = log;
    /** @type {Promise<{ frames: number, bytes: number, at: number }> | null} */
    this.refreshing = null;
    this.durable = durable;
    this.config = config;
    this.now = now;
    this.limits = limits;
    /** @type {{ frames: number, bytes: number, at: number } | null} what the mailbox holds across all pairs, read from the database at most every USAGE_MS and adjusted by this process's own stores in between */
    this.usage = null;
    /** @type {Map<string, string>} */
    this.epochs = new Map();
  }

  /** Forget a pair's epoch; it changes when a removed pair is created again. */
  forget(/** @type {string} */ pairId) {
    this.epochs.delete(pairId);
  }

  /** Runs one store call with the pair's epoch, once more with a fresh epoch if the cached one was retired. */
  async #run(/** @type {any} */ pair, /** @type {(epoch: string) => Promise<any>} */ op) {
    const first = await this.#once(pair, op);
    if (first.code !== 'retired') return first;
    this.epochs.delete(pair.pairId);
    return this.#once(pair, op);
  }

  async #once(/** @type {any} */ pair, /** @type {(epoch: string) => Promise<any>} */ op) {
    let epoch = this.epochs.get(pair.pairId);
    if (!epoch) {
      const opened = await this.durable.openEpoch({ pairId: pair.pairId, userId: pair.userId, sender: pair.macDeviceId });
      if (opened.code !== 'ok') return { code: opened.code };
      epoch = String(opened.epoch);
      this.epochs.set(pair.pairId, epoch);
    }
    return op(epoch);
  }

  /** Whether the relay as a whole is holding as much as it may: past it no pair may store another frame, however empty its own mailbox. */
  async #overQuota(/** @type {number} */ size) {
    const u = this.usage && this.now() - this.usage.at < USAGE_MS ? this.usage : await this.#refresh();
    return u.frames + 1 > this.limits.globalMaxFrames || u.bytes + size > this.limits.globalMaxBytes;
  }

  /**
   * Reads the relay-wide usage once however many stores ask at the same moment. A database that cannot answer leaves the last
   * count (or none: then only the per-pair caps apply) and is logged; the next store asks again after the usual interval.
   * @returns {Promise<{ frames: number, bytes: number, at: number }>}
   */
  #refresh() {
    this.refreshing ??= this.durable
      .usage()
      .then(
        (u) => (this.usage = { ...u, at: this.now() }),
        (e) => {
          this.log('usage_unreadable', { message: messageOf(e) });
          return (this.usage = { frames: this.usage?.frames ?? 0, bytes: this.usage?.bytes ?? 0, at: this.now() });
        },
      )
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** Deletes what is stored for one account's pairs; the relay-wide count is read again before the next store. @returns {Promise<number>} frames deleted */
  async clearAccount(/** @type {string} */ userId) {
    const n = await this.durable.clearAccount(userId);
    this.usage = null;
    return n;
  }

  /** @returns {Promise<{ code: 'stored' | 'duplicate' | 'expired' | 'conflict' | 'full' | string, scope?: 'pair' | 'account' | 'relay' }>} */
  async put(/** @type {any} */ pair, /** @type {string} */ sender, /** @type {any} */ f) {
    const size = f.nonce.length + f.box.length;
    // the store applies the relay-wide limit only to a frame it would add: a repeat of one it already holds is still answered
    const r = await this.#store(pair, sender, f, await this.#overQuota(size));
    if (r.code === 'stored' && this.usage) {
      this.usage.frames++;
      this.usage.bytes += size;
    }
    return r.code === 'full' && !r.scope ? { ...r, scope: 'pair' } : r;
  }

  #store(/** @type {any} */ pair, /** @type {string} */ sender, /** @type {any} */ f, /** @type {boolean} */ relayFull) {
    const { ttlMs, maxFrames, maxBytes } = this.config.mailbox;
    return this.#run(pair, (epoch) =>
      this.durable.enqueue({
        pairId: pair.pairId,
        epoch,
        userId: pair.userId,
        sender,
        dir: f.dir,
        ctr: f.ctr,
        nonce: f.nonce,
        box: f.box,
        maxFrames,
        maxBytes,
        accountMaxFrames: this.limits.accountMaxFrames,
        accountMaxBytes: this.limits.accountMaxBytes,
        relayFull,
        now: this.now(),
        ttlMs,
      }),
    );
  }

  /** The frames a receiver has not acknowledged yet and this connection has not been sent, oldest first. */
  async pending(
    /** @type {any} */ pair,
    /** @type {string} */ receiver,
    /** @type {string} */ dir,
    /** @type {number} */ afterCtr,
    /** @type {number} */ limit,
  ) {
    const r = await this.#run(pair, (epoch) =>
      this.durable.deliverable({ pairId: pair.pairId, epoch, userId: pair.userId, receiver, dir, afterCtr, limit, now: this.now() }),
    );
    return r.frames.map((/** @type {any} */ x) => ({ ctr: Number(x.ctr), nonce: Buffer.from(x.nonce), box: Buffer.from(x.box) }));
  }

  ack(/** @type {any} */ pair, /** @type {string} */ receiver, /** @type {string} */ dir, /** @type {number} */ ctr) {
    return this.#run(pair, (epoch) =>
      this.durable.ackByCtr({ pairId: pair.pairId, epoch, userId: pair.userId, receiver, dir, ctr, now: this.now() }),
    );
  }

  /** Expires every frame past its TTL; returns the pairs that lost frames, so their senders can be told. */
  async sweep() {
    const lost = [];
    for (const { pairId, epoch } of await this.durable.dueExpiry(this.now())) {
      const r = await this.durable.expire(pairId, epoch, this.now());
      if (r.code === 'ok' && r.count) lost.push(pairId);
    }
    return lost;
  }

  /** The drop notices a sender has not heard yet. */
  async drops(/** @type {any} */ pair, /** @type {string} */ sender, /** @type {string} */ dir) {
    const r = await this.#run(pair, (epoch) => this.durable.drops({ pairId: pair.pairId, epoch, userId: pair.userId, sender, dir }));
    return r.drops.map((/** @type {any} */ d) => ({
      id: String(d.id),
      dropped: Number(d.dropped),
      firstCtr: Number(d.first_ctr),
      lastCtr: Number(d.last_ctr),
    }));
  }

  /** A notice is removed only after the sender's socket took it, so it is not lost with a connection that dies mid-send. */
  ackDrop(
    /** @type {any} */ pair,
    /** @type {string} */ sender,
    /** @type {string} */ dir,
    /** @type {{ id: string, lastCtr: number }} */ d,
  ) {
    return this.#run(pair, (epoch) =>
      this.durable.ackDrop({ pairId: pair.pairId, epoch, userId: pair.userId, sender, dir, id: d.id, ctr: d.lastCtr }),
    );
  }
}
